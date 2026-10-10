import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { RelayFenceBrokerConfig } from './config.js'
import type {
  GoogleStorageMutationLease,
  MutationLease
} from './mutation-lease.js'

const commit = 'a'.repeat(40)
const config: RelayFenceBrokerConfig = {
  port: 8080,
  project: 'onorca-cloud',
  stateBucket: 'onorca-cloud-terraform-state',
  leaseObject: 'terraform/state/relay-fence-broker/production.lock',
  directorOrigin: 'https://relay.onorca.dev',
  adminAudience: 'https://relay.onorca.dev/v1/admin/drain',
  requesterServiceAccount: 'requester@example.com',
  runtimeServiceAccount: 'runtime@example.com',
  sourceCellId: 'production-gce-c3',
  failedTargetCellId: 'production-gce-c11',
  replacementTargetCellId: 'production-gce-c12',
  imageCommit: commit,
  terraformDir: 'infra/terraform',
  unobservedConnectionBound: 10,
  connectionCeiling: 600
}

function request(fenceCommit = commit): Request {
  return new Request('http://broker/v1/supersede-target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      operationId: 'c11-to-c12-forward',
      fenceCommit,
      confirmation: 'SUPERSEDE_TARGET'
    })
  })
}

function recoveryRequest(): Request {
  return new Request('http://broker/v1/supersede-target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      operationId: 'c11-to-c12-forward',
      fenceCommit: commit,
      completedFenceRecovery: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        fenceCommit: 'b'.repeat(40),
        gceOperation: 'operation-1',
        terraformStateSerial: 61,
        planObjectGeneration: '123',
        terraformStateObjectGeneration: '456',
        terraformStateObjectSha256: 'c'.repeat(64)
      },
      expectedLease: {
        generation: '7',
        operationId: 'c11-to-c12-forward',
        requestDigest: 'd'.repeat(64)
      },
      confirmation: 'SUPERSEDE_TARGET'
    })
  })
}

function leaseTakeoverRequest(): Request {
  return new Request('http://broker/v1/supersede-target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      operationId: 'c11-to-c12-forward',
      fenceCommit: commit,
      expectedLease: {
        generation: '7',
        operationId: 'c11-to-c12-forward',
        requestDigest: 'd'.repeat(64)
      },
      confirmation: 'SUPERSEDE_TARGET'
    })
  })
}

function sourceFenceRequest(
  overrides: Record<string, unknown> = {}
): Request {
  return new Request('http://broker/v1/fence-source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      operationId: 'c3-final-fence',
      fenceCommit: commit,
      targetCellIds: ['production-gce-c7', 'production-gce-c12'],
      confirmation: 'FENCE_SOURCE',
      ...overrides
    })
  })
}

describe('relay fence broker', () => {
  it('runs only after acquiring the durable lease', async () => {
    const events: string[] = []
    const lease = {
      acquire: vi.fn(async () => {
        events.push('acquire')
        return {
          generation: '7',
          record: {}
        } as MutationLease
      }),
      release: vi.fn(async () => {
        events.push('release')
      })
    } as unknown as GoogleStorageMutationLease
    const app = createApp(config, {
      lease,
      supersede: async () => {
        events.push('supersede')
      }
    })

    const response = await app.request(request())

    expect(response.status).toBe(200)
    expect(events).toEqual(['acquire', 'supersede', 'release'])
  })

  it('rejects a commit not bound to the immutable image', async () => {
    const lease = {
      acquire: vi.fn()
    } as unknown as GoogleStorageMutationLease
    const app = createApp(config, { lease })

    const response = await app.request(request('b'.repeat(40)))

    expect(response.status).toBe(409)
    expect(lease.acquire).not.toHaveBeenCalled()
  })

  it('retains the lease when supersession fails', async () => {
    const lease = {
      acquire: vi.fn(async () => ({ generation: '7', record: {} })),
      release: vi.fn()
    } as unknown as GoogleStorageMutationLease
    const app = createApp(config, {
      lease,
      supersede: async () => {
        throw new Error('stopped safely')
      }
    })

    const response = await app.request(request())

    expect(response.status).toBe(500)
    expect(lease.release).not.toHaveBeenCalled()
  })

  it('passes exact completed-attempt and live-lease recovery pins', async () => {
    const lease = {
      acquire: vi.fn(async () => ({ generation: '8', record: {} })),
      release: vi.fn()
    } as unknown as GoogleStorageMutationLease
    const supersede = vi.fn(async () => {})
    const app = createApp(config, { lease, supersede })

    const response = await app.request(recoveryRequest())

    expect(response.status).toBe(200)
    expect(lease.acquire).toHaveBeenCalledWith(
      'c11-to-c12-forward',
      expect.objectContaining({
        completedFenceRecovery: expect.objectContaining({
          terraformStateSerial: 61
        })
      }),
      {
        generation: '7',
        operationId: 'c11-to-c12-forward',
        requestDigest: 'd'.repeat(64)
      }
    )
    expect(supersede).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        attemptId: '11111111-1111-4111-8111-111111111111'
      })
    )
  })

  it('conditionally resumes the exact live supersession lease', async () => {
    const lease = {
      acquire: vi.fn(async () => ({ generation: '8', record: {} })),
      release: vi.fn()
    } as unknown as GoogleStorageMutationLease
    const supersede = vi.fn(async () => {})
    const app = createApp(config, { lease, supersede })

    const response = await app.request(leaseTakeoverRequest())

    expect(response.status).toBe(200)
    expect(lease.acquire).toHaveBeenCalledWith(
      'c11-to-c12-forward',
      expect.objectContaining({
        expectedLease: {
          generation: '7',
          operationId: 'c11-to-c12-forward',
          requestDigest: 'd'.repeat(64)
        }
      }),
      {
        generation: '7',
        operationId: 'c11-to-c12-forward',
        requestDigest: 'd'.repeat(64)
      }
    )
    expect(supersede).toHaveBeenCalledWith(config, undefined)
  })

  it('rejects a live supersession lease for another operation', async () => {
    const lease = {
      acquire: vi.fn()
    } as unknown as GoogleStorageMutationLease
    const app = createApp(config, { lease })
    const request = leaseTakeoverRequest()
    const body = (await request.json()) as {
      expectedLease: { operationId: string }
    }
    body.expectedLease.operationId = 'another-operation'

    const response = await app.request(
      new Request(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    )

    expect(response.status).toBe(400)
    expect(lease.acquire).not.toHaveBeenCalled()
  })

  it('fences the configured source only after acquiring the durable lease', async () => {
    const events: string[] = []
    const expectedLease = {
      generation: '6',
      operationId: 'c3-final-fence',
      requestDigest: 'd'.repeat(64)
    }
    const lease = {
      acquire: vi.fn(async () => {
        events.push('acquire')
        return { generation: '7', record: {} } as MutationLease
      }),
      release: vi.fn(async () => {
        events.push('release')
      })
    } as unknown as GoogleStorageMutationLease
    const fenceSource = vi.fn(async () => {
      events.push('fence')
    })
    const app = createApp(config, { lease, fenceSource })

    const response = await app.request(sourceFenceRequest({ expectedLease }))

    expect(response.status).toBe(200)
    expect(events).toEqual(['acquire', 'fence', 'release'])
    expect(lease.acquire).toHaveBeenCalledWith(
      'c3-final-fence',
      expect.objectContaining({ targetCellIds: expect.any(Array) }),
      expectedLease
    )
    expect(fenceSource).toHaveBeenCalledWith(config, [
      'production-gce-c7',
      'production-gce-c12'
    ])
  })

  it('rejects duplicate targets and the configured source', async () => {
    const lease = { acquire: vi.fn() } as unknown as GoogleStorageMutationLease
    const app = createApp(config, { lease })

    const duplicate = await app.request(
      sourceFenceRequest({
        targetCellIds: ['production-gce-c7', 'production-gce-c7']
      })
    )
    const source = await app.request(
      sourceFenceRequest({ targetCellIds: [config.sourceCellId] })
    )

    expect(duplicate.status).toBe(400)
    expect(source.status).toBe(400)
    expect(lease.acquire).not.toHaveBeenCalled()
  })

  it('retains the source-fence lease after a controlled failure', async () => {
    const lease = {
      acquire: vi.fn(async () => ({ generation: '7', record: {} })),
      release: vi.fn()
    } as unknown as GoogleStorageMutationLease
    const app = createApp(config, {
      lease,
      fenceSource: async () => {
        throw new Error('stopped safely')
      }
    })

    const response = await app.request(sourceFenceRequest())

    expect(response.status).toBe(500)
    expect(lease.release).not.toHaveBeenCalled()
  })
})
