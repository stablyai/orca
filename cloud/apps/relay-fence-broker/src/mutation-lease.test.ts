import { describe, expect, it, vi } from 'vitest'
import {
  GoogleStorageMutationLease,
  MutationLeaseConflict
} from './mutation-lease.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const accessToken = () => json({ access_token: 'a'.repeat(40) })
const request = {
  v: 1,
  operationId: 'c11-to-c12-forward',
  fenceCommit: 'a'.repeat(40),
  confirmation: 'SUPERSEDE_TARGET'
}

describe('GoogleStorageMutationLease', () => {
  it('creates and conditionally releases a new lease', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accessToken())
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(json({ generation: '7' }))
      .mockResolvedValueOnce(accessToken())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const leaseStore = new GoogleStorageMutationLease(
      'state-bucket',
      'fence/production.lock',
      'a'.repeat(40),
      fetcher,
      () => 1_000
    )

    const lease = await leaseStore.acquire(request.operationId, request)
    await leaseStore.release(lease)

    expect(lease.generation).toBe('7')
    expect(fetcher.mock.calls[2]?.[0]).toContain('ifGenerationMatch=0')
    expect(fetcher.mock.calls[4]?.[0]).toContain('ifGenerationMatch=7')
  })

  it('rejects a different request while the durable lease is live', async () => {
    const existing = {
      operationId: 'other-operation',
      requestDigest: 'b'.repeat(64),
      imageCommit: 'a'.repeat(40),
      acquiredAt: 500,
      expiresAt: 2_000
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accessToken())
      .mockResolvedValueOnce(json({ generation: '7' }))
      .mockResolvedValueOnce(json(existing))
    const leaseStore = new GoogleStorageMutationLease(
      'state-bucket',
      'fence/production.lock',
      'a'.repeat(40),
      fetcher,
      () => 1_000
    )

    await expect(
      leaseStore.acquire(request.operationId, request)
    ).rejects.toBeInstanceOf(MutationLeaseConflict)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('takes over an expired lease with an exact generation precondition', async () => {
    const existing = {
      operationId: 'other-operation',
      requestDigest: 'b'.repeat(64),
      imageCommit: 'a'.repeat(40),
      acquiredAt: 500,
      expiresAt: 999
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accessToken())
      .mockResolvedValueOnce(json({ generation: '7' }))
      .mockResolvedValueOnce(json(existing))
      .mockResolvedValueOnce(json({ generation: '8' }))
    const leaseStore = new GoogleStorageMutationLease(
      'state-bucket',
      'fence/production.lock',
      'a'.repeat(40),
      fetcher,
      () => 1_000
    )

    const lease = await leaseStore.acquire(request.operationId, request)

    expect(lease.generation).toBe('8')
    expect(fetcher.mock.calls[3]?.[0]).toContain('ifGenerationMatch=7')
  })

  it('conditionally replaces the exact authorized live lease', async () => {
    const existing = {
      operationId: request.operationId,
      requestDigest: 'b'.repeat(64),
      imageCommit: 'b'.repeat(40),
      acquiredAt: 500,
      expiresAt: 2_000
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accessToken())
      .mockResolvedValueOnce(json({ generation: '7' }))
      .mockResolvedValueOnce(json(existing))
      .mockResolvedValueOnce(json({ generation: '8' }))
    const leaseStore = new GoogleStorageMutationLease(
      'state-bucket',
      'fence/production.lock',
      'a'.repeat(40),
      fetcher,
      () => 1_000
    )

    const lease = await leaseStore.acquire(request.operationId, request, {
      generation: '7',
      operationId: existing.operationId,
      requestDigest: existing.requestDigest
    })

    expect(lease.generation).toBe('8')
    expect(fetcher.mock.calls[3]?.[0]).toContain('ifGenerationMatch=7')
  })

  it('rejects a live-lease takeover when any expected field differs', async () => {
    const existing = {
      operationId: request.operationId,
      requestDigest: 'b'.repeat(64),
      imageCommit: 'b'.repeat(40),
      acquiredAt: 500,
      expiresAt: 2_000
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accessToken())
      .mockResolvedValueOnce(json({ generation: '7' }))
      .mockResolvedValueOnce(json(existing))
    const leaseStore = new GoogleStorageMutationLease(
      'state-bucket',
      'fence/production.lock',
      'a'.repeat(40),
      fetcher,
      () => 1_000
    )

    await expect(
      leaseStore.acquire(request.operationId, request, {
        generation: '8',
        operationId: existing.operationId,
        requestDigest: existing.requestDigest
      })
    ).rejects.toBeInstanceOf(MutationLeaseConflict)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
