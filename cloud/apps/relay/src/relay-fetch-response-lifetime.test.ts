import { describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { googleMetadataIdentityToken } from './google-metadata-identity-token.js'
import { probeRegionalRehomeTrust } from './regional-rehome-trust-probe.js'
import { createRelayReadiness } from './relay-readiness.js'
import type { RelayDatabase } from './database.js'

describe('relay authentication and trust response lifetime', () => {
  it.each([200, 503])('closes real streaming JWKS responses after status %i', async (status) => {
    let activeResponses = 0
    const server = createServer((_request, response) => {
      activeResponses++
      response.once('close', () => {
        activeResponses--
      })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.write('{')
    })
    const database: RelayDatabase = {
      query: async () => [{ ready: 1 }],
      queryLocked: async () => [],
      transaction: async (operation) => operation(database),
      close: async () => {}
    }
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing test server port')
      const readiness = createRelayReadiness(database, `http://127.0.0.1:${address.port}/jwks`, {
        cacheMs: 0,
        timeoutMs: 60_000
      })
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(await readiness.check()).toBe(status === 200)
        await vi.waitFor(() => expect(activeResponses).toBe(0), { timeout: 1_000 })
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('cancels a rejected metadata response before returning its status error', async () => {
    const cancel = vi.fn()
    const fetchImpl: typeof fetch = async () =>
      new Response(new ReadableStream({ cancel }), { status: 503 })

    await expect(googleMetadataIdentityToken('audience', fetchImpl)).rejects.toThrow(
      'metadata_identity_503'
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('consumes a successful metadata response', async () => {
    const response = new Response('identity-token')
    expect(await googleMetadataIdentityToken('audience', async () => response)).toBe(
      'identity-token'
    )
    expect(response.bodyUsed).toBe(true)
  })

  it('cancels a rejected trust probe response before returning its status error', async () => {
    const cancel = vi.fn()
    await expect(
      probeRegionalRehomeTrust({
        sourceCellUrl: 'https://cell.example.test',
        sourceCellId: 'cell-a',
        sourceCellIncarnation: 'incarnation',
        audience: 'audience',
        identityToken: async () => 'identity-token',
        fetch: async () => new Response(new ReadableStream({ cancel }), { status: 503 })
      })
    ).rejects.toThrow('regional_rehome_trust_probe_source_503')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('preserves the status error when the discarded body has already errored', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('response stream failed'))
        }
      }),
      { status: 503 }
    )

    await expect(googleMetadataIdentityToken('audience', async () => response)).rejects.toThrow(
      'metadata_identity_503'
    )
  })
})
