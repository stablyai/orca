import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD } from '../shared/pty-ownership-transfer-destination-claim'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  context,
  credential,
  identity,
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'

const replayRequest = {
  ...request(),
  destinationClaim: { generation: 1, claimId: 'claim-1' },
  afterSeq: 0
}

describe('destination-authenticated prepared replay', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-destination-replay-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function setup(patch: Parameters<typeof makeDelegatedRelay>[1] = {}) {
    const adapter = makeDelegatedRelay(store, patch)
    const handlers = new Map<string, MethodHandler>()
    adapter.register({
      onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler)
    } as unknown as RelayDispatcher)
    const replay = handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD)
    return { adapter, replay }
  }

  it('catches up without desktop authorization, writes, input or secret publication', async () => {
    const authorizeRequest = vi.fn(() => false)
    const writeDestinationInput = vi.fn()
    const { adapter, replay } = setup({ authorizeRequest, writeDestinationInput })
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    adapter.observeOutput(identity.terminalId, 'first')
    adapter.observeOutput(identity.terminalId, 'second')
    const save = vi.spyOn(store, 'save')
    const result = await replay!(replayRequest, context())
    expect(result).toMatchObject({
      phase: 'prepared',
      sourceOutputEndSeq: 2,
      frames: [
        { seq: 1, data: 'first' },
        { seq: 2, data: 'second' }
      ]
    })
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(result).not.toHaveProperty('destinationClaim')
    expect(result).not.toHaveProperty('destinationDelegation')
    expect(save).not.toHaveBeenCalled()
    expect(authorizeRequest).not.toHaveBeenCalled()
    expect(writeDestinationInput).not.toHaveBeenCalled()
    await expect(replay!({ ...replayRequest, afterSeq: 1 }, context())).resolves.toMatchObject({
      frames: [{ seq: 2, data: 'second' }]
    })
  })

  it.each([
    { credential: 'f'.repeat(64) },
    { destinationRuntimeId: 'wrong' },
    { destinationClaim: { generation: 2, claimId: 'claim-2' } },
    { destinationClaim: { generation: 1, claimId: 'wrong' } },
    { afterSeq: -1 },
    { afterSeq: 1 },
    { attachmentId: 'unsupported' }
  ])('rejects invalid proof, claim or cursor %#', async (patch) => {
    const { adapter, replay } = setup()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    await expect(replay!({ ...replayRequest, ...patch }, context())).rejects.toThrow()
  })

  it('fences other sockets, stale connections and superseded claims on the same socket', async () => {
    const { adapter, replay } = setup()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    for (const caller of [
      context(3),
      context(2, 2),
      { ...context(), isStale: () => true },
      { ...context(), sessionIdentity: undefined }
    ]) {
      await expect(replay!(replayRequest, caller)).rejects.toThrow()
    }
    adapter.claimDestination(request(2), context())
    await expect(replay!(replayRequest, context())).rejects.toThrow('claim_stale')
    await expect(
      replay!(
        { ...replayRequest, destinationClaim: { generation: 2, claimId: 'claim-2' } },
        context()
      )
    ).resolves.toMatchObject({ frames: [] })
  })

  it('requires reclaim after adapter restart and refuses an aborted transfer', async () => {
    const { adapter } = setup()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    const restored = setup()
    await expect(restored.replay!(replayRequest, context())).rejects.toThrow('claim_stale')
    restored.adapter.abort(preparation)
    await expect(restored.replay!(replayRequest, context())).rejects.toThrow('claim_unavailable')
  })

  it('refuses evicted checkpoints instead of silently truncating replay', async () => {
    const { adapter, replay } = setup({ replayBytes: 6 })
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    adapter.observeOutput(identity.terminalId, 'first')
    adapter.observeOutput(identity.terminalId, 'second')
    await expect(replay!(replayRequest, context())).rejects.toThrow('no longer retained')
    await expect(replay!({ ...replayRequest, afterSeq: 1 }, context())).resolves.toMatchObject({
      frames: [{ seq: 2, data: 'second' }]
    })
  })

  it('does not register without the implementation gate', () => {
    expect(setup({ enableDestinationDelegationClaims: false }).replay).toBeUndefined()
  })

  it.each([false, true])('keeps uncertain claim writes fenced (written: %s)', async (written) => {
    let fail = false
    const { adapter, replay } = setup({
      store: {
        loadAll: () => store.loadAll(),
        remove: (id) => store.remove(id),
        save: (record) => {
          if (!fail || written) {
            store.save(record)
          }
          if (fail) {
            throw new Error('uncertain save')
          }
        }
      }
    })
    adapter.prepare(preparation)
    fail = true
    expect(() => adapter.claimDestination(request(), context())).toThrow('uncertain save')
    await expect(replay!(replayRequest, context())).rejects.toThrow('claim_unavailable')
    fail = false
    adapter.recoverDestination(request(), context())
    await expect(replay!(replayRequest, context())).rejects.toThrow('claim_stale')
    adapter.claimDestination(request(2), context())
    await expect(
      replay!(
        { ...replayRequest, destinationClaim: { generation: 2, claimId: 'claim-2' } },
        context()
      )
    ).resolves.toMatchObject({ frames: [] })
  })

  it.each([false, true])(
    'reads only the retained prefix after failed output save (written: %s)',
    async (written) => {
      let fail = false
      const { adapter, replay } = setup({
        store: {
          loadAll: () => store.loadAll(),
          remove: (id) => store.remove(id),
          save: (record) => {
            if (!fail || written) {
              store.save(record)
            }
            if (fail) {
              throw new Error('output save failed')
            }
          }
        }
      })
      adapter.prepare(preparation)
      adapter.claimDestination(request(), context())
      adapter.observeOutput(identity.terminalId, 'first', '0:5')
      fail = true
      expect(() => adapter.observeOutput(identity.terminalId, 'second', '5:11')).toThrow()
      await expect(replay!(replayRequest, context())).resolves.toMatchObject({
        sourceOutputEndSeq: 1,
        frames: [{ seq: 1, data: 'first' }]
      })
      fail = false
      adapter.observeOutput(identity.terminalId, 'second', '5:11')
      await expect(replay!(replayRequest, context())).resolves.toMatchObject({
        sourceOutputEndSeq: 2,
        frames: [
          { seq: 1, data: 'first' },
          { seq: 2, data: 'second' }
        ]
      })
    }
  )
})
