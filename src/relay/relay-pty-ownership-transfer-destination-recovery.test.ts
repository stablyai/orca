import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  credential,
  identity,
  preparation,
  request,
  context,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import type { RelayDispatcher, MethodHandler } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD } from '../shared/pty-ownership-transfer-destination-claim'

const proof = { version: 1, ...identity, credential }
describe('in-place destination durability recovery', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  let failure: 'none' | 'before' | 'after'
  const fence = vi.fn()
  const save = vi.fn((record: RelayPtyOwnershipTransferDurableRecord) => {
    if (failure !== 'before') {
      store.save(record)
    }
    if (failure !== 'none') {
      throw new Error('uncertain write')
    }
  })
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-destination-recovery-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
    failure = 'none'
    fence.mockReset()
    save.mockClear()
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const relay = () =>
    makeDelegatedRelay(
      { loadAll: () => store.loadAll(), save, remove: (id) => store.remove(id) },
      { setInputFenced: fence }
    )

  it.each(['before', 'after'] as const)(
    'recovers uncertain claim in the same adapter (%s durable save)',
    (when) => {
      const adapter = relay()
      adapter.prepare(preparation)
      adapter.claimDestination(request(), context())
      failure = when
      expect(() => adapter.claimDestination(request(2), context(3))).toThrow('uncertain write')
      expect(() => adapter.recoverDestination(proof, context(3))).toThrow('uncertain write')
      expect(() => adapter.inspectDestination(proof, context(3))).toThrow('claim_unavailable')
      failure = 'none'
      adapter.observeOutput('pty-1', 'output while fenced')
      const frames = store.loadAll()[0].history.frames
      expect(adapter.recoverDestination(proof, context(3))).toMatchObject({
        destinationClaim: { generation: 2 },
        boundToConnection: false
      })
      expect(store.loadAll()[0].history.frames).toEqual(frames)
      expect(makeDelegatedRelay(store).inspectDestination(proof, context(4))).toMatchObject({
        phase: 'prepared',
        destinationClaim: { generation: 2 },
        boundToConnection: false
      })
      expect(frames.map((frame) => frame.data).join('')).toBe('output while fenced')
      expect(fence).not.toHaveBeenCalledWith('pty-1', false)
      expect(
        adapter.isDestinationClaimActive(identity, { generation: 1, claimId: 'claim-1' }, context())
      ).toBe(false)
      expect(() => adapter.claimDestination(request(2), context(3))).toThrow('claim_stale')
      adapter.claimDestination(request(3), context(3))
      expect(adapter.inspectDestination(proof, context(3)).boundToConnection).toBe(true)
    }
  )

  it.each(['before', 'after'] as const)(
    'recovers uncertain preparation without releasing source input (%s save)',
    (when) => {
      const adapter = relay()
      failure = when
      expect(() => adapter.prepare(preparation)).toThrow('uncertain write')
      failure = 'none'
      expect(adapter.recoverDestination(proof, context())).toMatchObject({
        phase: 'prepared',
        destinationClaim: null,
        boundToConnection: false
      })
      expect(adapter.prepare(preparation)).toMatchObject({ phase: 'prepared' })
      expect(fence.mock.calls).toEqual([['pty-1', true]])
      adapter.claimDestination(request(), context())
      expect(adapter.inspectDestination(proof, context()).boundToConnection).toBe(true)
    }
  )

  it('does not write or disturb a healthy incumbent on retry after a lost recovery response', () => {
    const adapter = relay()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    save.mockClear()
    expect(adapter.recoverDestination(proof, context(3)).boundToConnection).toBe(false)
    expect(adapter.recoverDestination(proof, context()).boundToConnection).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['before', 'after'] as const)(
    'recovers a failed prepare reflush through the existing proof route (%s save)',
    (when) => {
      const adapter = relay()
      adapter.prepare(preparation)
      failure = when
      expect(() => adapter.prepare(preparation)).toThrow('uncertain write')
      failure = 'none'
      save.mockClear()
      expect(() =>
        adapter.recoverDestination({ ...proof, credential: '0'.repeat(64) }, context())
      ).toThrow('unauthorized')
      expect(save).not.toHaveBeenCalled()
      expect(adapter.recoverDestination(proof, context())).toMatchObject({
        phase: 'prepared',
        destinationClaim: null,
        boundToConnection: false
      })
      expect(save).toHaveBeenCalledOnce()
      expect(adapter.prepare(preparation)).toMatchObject({ phase: 'prepared' })
      expect(save).toHaveBeenCalledTimes(2)
      expect(fence.mock.calls).toEqual([['pty-1', true]])
    }
  )

  it.each([
    { credential: 'f'.repeat(64) },
    { destinationRuntimeId: 'other-host' },
    { credential: undefined }
  ])('refuses unauthorized recovery before any write %#', (patch) => {
    const adapter = relay()
    adapter.prepare(preparation)
    failure = 'before'
    expect(() => adapter.claimDestination(request(), context())).toThrow()
    failure = 'none'
    save.mockClear()
    expect(() => adapter.recoverDestination({ ...proof, ...patch }, context())).toThrow()
    expect(save).not.toHaveBeenCalled()
    expect(() => adapter.inspectDestination(proof, context())).toThrow('claim_unavailable')
  })

  it('preserves an acknowledged abort when recovering uncertainty', () => {
    const adapter = relay()
    adapter.prepare(preparation)
    failure = 'after'
    expect(() => adapter.claimDestination(request(), context())).toThrow()
    failure = 'none'
    adapter.abort(preparation)
    expect(adapter.recoverDestination(proof, context())).toMatchObject({
      phase: 'aborted',
      boundToConnection: false
    })
    expect(store.loadAll()[0].phase).toBe('aborted')
    expect(() => adapter.claimDestination(request(2), context())).toThrow('claim_unavailable')
  })

  it('does not bind a connection that becomes stale during recovery persistence', () => {
    const adapter = relay()
    adapter.prepare(preparation)
    failure = 'before'
    expect(() => adapter.claimDestination(request(), context())).toThrow()
    failure = 'none'
    let stale = false
    save.mockImplementationOnce((record) => {
      store.save(record)
      stale = true
    })
    expect(() => adapter.recoverDestination(proof, { ...context(), isStale: () => stale })).toThrow(
      'claim_unauthorized'
    )
    expect(adapter.inspectDestination(proof, context(3))).toMatchObject({
      destinationClaim: { generation: 1 },
      boundToConnection: false
    })
  })

  it('registers recovery only under the disabled production gate', async () => {
    const handlers = new Map<string, MethodHandler>()
    const dispatcher = {
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
    } as unknown as RelayDispatcher
    makeDelegatedRelay(store, { enableDestinationDelegationClaims: undefined }).register(dispatcher)
    expect(handlers.has(PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD)).toBe(false)
    const adapter = relay()
    adapter.prepare(preparation)
    adapter.register(dispatcher)
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD)!(proof, context())
    ).resolves.toMatchObject({ destinationClaim: null })
  })
})
