import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { RelayFenceBrokerConfig } from './config.js'
import type { GoogleStorageMutationLease } from './mutation-lease.js'

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

  it('rejects a commit not bound to the immutable image', async () => {
    const lease = {
      acquire: vi.fn()
    } as unknown as GoogleStorageMutationLease
    const app = createApp(config, { lease })

    const response = await app.request(request('b'.repeat(40)))

    expect(response.status).toBe(409)
    expect(lease.acquire).not.toHaveBeenCalled()
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
})
