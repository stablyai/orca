import { once } from 'node:events'
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELAY_PROTOCOL_LIMITS } from '@orca-cloud/relay-contract'
import { loadRelayConfig } from './config.js'
import type { RelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'

describe('relay HTTP request body limit', () => {
  const closeServers: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const close of closeServers.splice(0)) await close()
  })

  async function relay() {
    const query = vi.fn(async () => [])
    const database: RelayDatabase = {
      query,
      queryLocked: query,
      transaction: async (operation) => operation(database),
      close: async () => {}
    }
    const config = loadRelayConfig({
      ORCA_RELAY_ROLE: 'director',
      ORCA_RELAY_PUBLIC_URL: 'http://127.0.0.1:8080',
      ORCA_RELAY_CELL_URL: 'http://127.0.0.1:8080',
      ORCA_RELAY_AUTH_ISSUER: 'https://auth.example.test',
      ORCA_RELAY_JWKS_URL: 'https://auth.example.test/jwks',
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'test-assignment-key-with-at-least-32-bytes',
      ORCA_RELAY_ADMIN_AUDIENCE: 'https://relay.example.test/admin',
      ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test',
      ORCA_RELAY_CELLS_JSON: JSON.stringify([
        { id: 'cell-a', url: 'https://cell.example.test', capacityRequests: 900 }
      ])
    })
    const { server } = createRelayServer(config, database)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    closeServers.push(async () => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server port')
    return { port: address.port, query }
  }

  it('rejects a chunked upload before its sender finishes or reaches the database', async () => {
    const { port, query } = await relay()
    const client = request({
      host: '127.0.0.1',
      port,
      path: '/v1/resolve',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
    })
    const result = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      client.once('error', reject)
      client.once('response', (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.once('error', reject)
        response.once('end', () => resolve({ status: response.statusCode, body }))
      })
    })
    const timeout = setTimeout(() => client.destroy(new Error('body limit did not respond')), 2_000)
    try {
      client.write(' '.repeat(RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes + 1))
      expect(await result).toEqual({ status: 413, body: '{"error":"request_too_large"}' })
      expect(query).not.toHaveBeenCalled()
    } finally {
      clearTimeout(timeout)
      client.destroy()
    }
  })

  it.each([0, 1])('enforces the byte boundary with %i bytes over the limit', async (extra) => {
    const { port, query } = await relay()
    const json = JSON.stringify({
      v: 1,
      relayHostId: 'abcdefghijklmnop',
      resumeToken: 'a'.repeat(43)
    })
    const body = json.padEnd(RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes + extra)
    const response = await fetch(`http://127.0.0.1:${port}/v1/resolve`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' }
    })
    expect(response.status).toBe(extra === 0 ? 401 : 413)
    expect(await response.json()).toEqual({
      error: extra === 0 ? 'invalid_credential' : 'request_too_large'
    })
    expect(query).toHaveBeenCalledTimes(extra === 0 ? 1 : 0)
  })
})
