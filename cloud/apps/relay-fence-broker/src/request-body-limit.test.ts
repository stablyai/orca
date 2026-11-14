import { createAdaptorServer } from '@hono/node-server'
import { once } from 'node:events'
import { request } from 'node:http'
import { expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { GoogleStorageMutationLease } from './mutation-lease.js'

const commit = 'a'.repeat(40)
const config = loadConfig({
  ORCA_RELAY_FENCE_PROJECT: 'test-project',
  ORCA_RELAY_FENCE_STATE_BUCKET: 'test-bucket',
  ORCA_RELAY_FENCE_LEASE_OBJECT: 'test-lease',
  ORCA_RELAY_FENCE_DIRECTOR_ORIGIN: 'https://relay.example.test',
  ORCA_RELAY_FENCE_ADMIN_AUDIENCE: 'https://relay.example.test/v1/admin/drain',
  ORCA_RELAY_FENCE_REQUESTER_SERVICE_ACCOUNT: 'requester@example.test',
  ORCA_RELAY_FENCE_RUNTIME_SERVICE_ACCOUNT: 'runtime@example.test',
  ORCA_RELAY_FENCE_SOURCE_CELL_ID: 'source-cell',
  ORCA_RELAY_FENCE_FAILED_TARGET_CELL_ID: 'failed-cell',
  ORCA_RELAY_FENCE_REPLACEMENT_TARGET_CELL_ID: 'replacement-cell',
  ORCA_RELAY_FENCE_IMAGE_COMMIT: commit,
  ORCA_RELAY_FENCE_UNOBSERVED_CONNECTION_BOUND: '10'
})

function broker() {
  const lease = new GoogleStorageMutationLease('test-bucket', 'test-lease', commit)
  const acquire = vi.spyOn(lease, 'acquire').mockResolvedValue({
    generation: '7',
    record: {
      operationId: 'test-operation',
      requestDigest: 'a'.repeat(64),
      imageCommit: commit,
      acquiredAt: 1,
      expiresAt: 2
    }
  })
  vi.spyOn(lease, 'release').mockResolvedValue()
  const operation = vi.fn(async () => {})
  return {
    app: createApp(config, { lease, supersede: operation, fenceSource: operation }),
    acquire,
    operation
  }
}

function largestRequest(path: string) {
  const operationId = 'a'.repeat(128)
  const base = {
    v: 1,
    operationId,
    fenceCommit: commit,
    expectedLease: { generation: '9'.repeat(31), operationId, requestDigest: 'a'.repeat(64) }
  }
  return path === '/v1/fence-source'
    ? {
        ...base,
        confirmation: 'FENCE_SOURCE',
        targetCellIds: Array.from({ length: 16 }, (_, i) => `cell-${i}-`.padEnd(128, 'b'))
      }
    : {
        ...base,
        confirmation: 'SUPERSEDE_TARGET',
        completedFenceRecovery: {
          attemptId: '11111111-1111-4111-8111-111111111111',
          fenceCommit: commit,
          gceOperation: 'x'.repeat(256),
          terraformStateSerial: Number.MAX_SAFE_INTEGER,
          planObjectGeneration: '9'.repeat(31),
          terraformStateObjectGeneration: '9'.repeat(31),
          terraformStateObjectSha256: 'a'.repeat(64)
        }
      }
}

it.each(['/v1/fence-source', '/v1/supersede-target'])(
  'rejects an unfinished chunked upload to %s before acquiring the lease',
  async (path) => {
    const { app, acquire, operation } = broker()
    const server = createAdaptorServer(app)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server port')
    const client = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
    })
    const result = new Promise<number | undefined>((resolve, reject) => {
      client.once('error', reject)
      client.once('response', (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
        response.once('error', reject)
      })
    })
    const timeout = setTimeout(() => client.destroy(new Error('body limit did not respond')), 1000)
    try {
      client.write(' '.repeat(16 * 1024 + 1))
      expect(await result).toBe(413)
      expect(acquire).not.toHaveBeenCalled()
      expect(operation).not.toHaveBeenCalled()
    } finally {
      clearTimeout(timeout)
      client.destroy()
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
)

it.each(['/v1/fence-source', '/v1/supersede-target'])(
  'accepts maximal schema fields at 16 KiB and rejects one byte more on %s',
  async (path) => {
    const { app, acquire } = broker()
    const json = JSON.stringify(largestRequest(path))
    expect(Buffer.byteLength(json)).toBeLessThan(16 * 1024)
    for (const extra of [0, 1]) {
      const response = await app.request(path, {
        method: 'POST',
        body: json.padEnd(16 * 1024 + extra),
        headers: { 'content-type': 'application/json' }
      })
      expect(response.status).toBe(extra === 0 ? 200 : 413)
      if (extra) expect(await response.json()).toEqual({ error: 'request_too_large' })
      expect(acquire).toHaveBeenCalledOnce()
    }
  }
)
