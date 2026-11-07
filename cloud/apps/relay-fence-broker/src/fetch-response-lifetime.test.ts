import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { metadataAccessToken } from './google-metadata.js'
import { GoogleStorageMutationLease } from './mutation-lease.js'

const commit = 'a'.repeat(40)
const record = {
  operationId: 'test-operation',
  requestDigest: 'b'.repeat(64),
  imageCommit: commit,
  acquiredAt: 1,
  expiresAt: 2
}
const cases = [
  { stage: 'metadata', status: 503, error: 'metadata request failed: 503' },
  { stage: 'inspect', status: 404 },
  { stage: 'inspect', status: 503, error: 'mutation lease inspection failed: 503' },
  { stage: 'body', status: 503, error: 'mutation lease body read failed: 503' },
  { stage: 'acquire', status: 412, error: 'relay mutation lease changed concurrently' },
  { stage: 'acquire', status: 503, error: 'mutation lease acquisition failed: 503' },
  { stage: 'release', status: 200 },
  { stage: 'release', status: 404 },
  { stage: 'release', status: 503, error: 'mutation lease release failed: 503' }
] as const

it.each(cases)('closes the unused $stage response after status $status', async (scenario) => {
  let activeResponses = 0
  const server = createServer((_request, response) => {
    activeResponses++
    response.once('close', () => {
      activeResponses--
    })
    response.writeHead(scenario.status, { 'content-type': 'application/json' })
    response.write('{')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server port')
    const streamedResponse = () => fetch(`http://127.0.0.1:${address.port}`)
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('metadata.google.internal')) {
        return scenario.stage === 'metadata'
          ? streamedResponse()
          : Response.json({ access_token: 'a'.repeat(40) })
      }
      if (init?.method === 'DELETE') return streamedResponse()
      if (init?.method === 'POST') {
        return scenario.stage === 'acquire'
          ? streamedResponse()
          : Response.json({ generation: '7' })
      }
      if (url.endsWith('?alt=media')) return streamedResponse()
      return scenario.stage === 'inspect'
        ? streamedResponse()
        : scenario.stage === 'body'
          ? Response.json({ generation: '7' })
          : new Response(null, { status: 404 })
    }
    const lease = new GoogleStorageMutationLease('test-bucket', 'test-lease', commit, fetcher)
    for (let attempt = 0; attempt < 10; attempt++) {
      const pending =
        scenario.stage === 'metadata'
          ? metadataAccessToken(fetcher)
          : scenario.stage === 'release'
            ? lease.release({ generation: '7', record })
            : lease.acquire(record.operationId, {})
      if ('error' in scenario) await expect(pending).rejects.toThrow(scenario.error)
      else await pending
      await vi.waitFor(() => expect(activeResponses).toBe(0), { timeout: 1000 })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

it('preserves the status error when cancellation rejects', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('stream failed'))
        }
      }),
      { status: 503 }
    )
  await expect(metadataAccessToken(fetcher)).rejects.toThrow('metadata request failed: 503')
})
