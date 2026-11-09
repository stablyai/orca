// #36923: opening a sleeping paired recipe VM wakes it, and the wake re-pairs its server. The
// opening request is held to its caller's pairing as of before that wake, then to the pairing the
// wake made; any other change still refuses it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'

const BEFORE: KnownRuntimeEnvironment = {
  id: 'env-vm',
  name: 'VM',
  pairingRevision: 1,
  runtimeId: 'before',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  endpoints: [
    {
      id: 'ep',
      kind: 'websocket',
      label: 'VM',
      endpoint: 'ws://vm.test',
      deviceToken: 'token',
      publicKeyB64: 'key'
    }
  ],
  preferredEndpointId: 'ep'
}
const AFTER_WAKE = { id: 'env-vm', pairingRevision: 2, runtimeId: 'after', createdAt: 0 }

type Prepared = {
  environment: Record<string, unknown>
  before: Record<string, unknown>
  wokenPairingRevision: number | null
}
const prepared = vi.hoisted((): { current: Prepared | null } => ({ current: null }))
const prepare = vi.hoisted(() => vi.fn(async () => prepared.current))
vi.mock('./runtime-environment-managed-tunnel', () => ({ prepareManagedRuntimeRequest: prepare }))
// The record a caller's fence is first checked against, before anything can wake the VM.
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => prepared.current?.before
}))

import { prepareFencedRuntimeRequest } from './runtime-environment-request-preparation'

function fence(pairingRevision: number, runtimeId: string) {
  return prepareFencedRuntimeRequest('/user-data', 'env-vm', 'worktree.activate', undefined, {
    pairingRevision,
    runtimeId
  })
}

describe('a request whose own recipe VM wake re-paired its server', () => {
  beforeEach(() => {
    prepare.mockClear()
    prepared.current = { environment: AFTER_WAKE, before: BEFORE, wokenPairingRevision: 2 }
  })

  it('passes the fence its caller set before the wake, then expects the new pairing', async () => {
    await expect(fence(1, 'before')).resolves.toMatchObject({
      failure: null,
      expected: { pairingRevision: 2, runtimeId: undefined }
    })
  })

  it('refuses a stale caller before its request can wake the VM', async () => {
    const result = await fence(0, 'before')
    expect(result.failure).toMatchObject({ ok: false })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('refuses an unrelated re-pair after its own wake', async () => {
    prepared.current = {
      environment: { ...AFTER_WAKE, pairingRevision: 3 },
      before: BEFORE,
      wokenPairingRevision: 2
    }
    expect((await fence(1, 'before')).failure).toMatchObject({ ok: false })
  })
})

describe('a fenced request that waited through a wake already in flight', () => {
  beforeEach(() => {
    prepare.mockClear()
    // By the time the request takes its slot the record already holds the new pairing; its own
    // preparation woke nothing.
    prepared.current = { environment: AFTER_WAKE, before: AFTER_WAKE, wokenPairingRevision: null }
  })

  const heldFence = (pairingRevision: number, wokenPairingRevision: number | null) =>
    prepareFencedRuntimeRequest(
      '/user-data',
      'env-vm',
      'terminal.list',
      undefined,
      { pairingRevision, runtimeId: 'before' },
      undefined,
      { before: BEFORE, wokenPairingRevision }
    )

  it('passes the pre-wake fence and then expects the pairing that wake made', async () => {
    await expect(heldFence(1, 2)).resolves.toMatchObject({
      failure: null,
      expected: { pairingRevision: 2, runtimeId: undefined }
    })
  })

  it('still refuses a caller fenced to an older pairing', async () => {
    expect((await heldFence(0, 2)).failure).toMatchObject({ ok: false })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('without the held wake, the same call is refused as changed', async () => {
    const result = await prepareFencedRuntimeRequest(
      '/user-data',
      'env-vm',
      'terminal.list',
      undefined,
      { pairingRevision: 1, runtimeId: 'before' }
    )
    expect(result.failure).toMatchObject({ ok: false })
  })
})
