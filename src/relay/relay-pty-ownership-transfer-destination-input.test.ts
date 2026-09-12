import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD
} from '../shared/pty-ownership-transfer-destination-input'

describe('claim-bound destination input', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  let failAt: number
  let saves: number
  let afterWrite: boolean
  const write = vi.fn()
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-destination-input-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
    const initial = makeDelegatedRelay(store, { enableDestinationOutputRetention: true })
    initial.prepare(preparation)
    initial.claimDestination(request(), context())
    store.save({
      ...store.loadAll()[0],
      version: 5,
      phase: 'committed',
      commitReceipt: {
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 0,
        receiptId: 'committed',
        committedAt: '2026-09-06T00:00:00.000Z'
      }
    })
    failAt = -1
    saves = 0
    afterWrite = false
    write.mockReset()
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  function setup(generation = 2, enabled = true) {
    const adapter = makeDelegatedRelay(
      {
        loadAll: () => store.loadAll(),
        remove: (id) => store.remove(id),
        save: (record) => {
          saves++
          if (saves !== failAt || afterWrite) {
            store.save(record)
          }
          if (saves === failAt) {
            throw new Error('uncertain input save')
          }
        }
      },
      {
        enableDestinationDelegationInput: enabled,
        inputIds: 2,
        resolveSource: () => null,
        resolveTerminalIncarnation: () => identity.incarnationId,
        writeDestinationInput: write
      }
    )
    adapter.claimDestination(request(generation), context())
    const handlers = new Map<string, MethodHandler>()
    adapter.register({
      onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler)
    } as unknown as RelayDispatcher)
    const input = (
      data = 'command\n',
      inputId = 'input-1',
      claimGeneration = generation,
      inputEpoch = 0
    ) =>
      handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD)!(
        {
          ...request(claimGeneration),
          data,
          inputId,
          inputEpoch,
          destinationClaim: { generation: claimGeneration, claimId: `claim-${claimGeneration}` }
        },
        context()
      )
    const retire = (inputIds: string[], inputEpoch = 0, claimGeneration = generation) =>
      handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD)!(
        {
          ...request(claimGeneration),
          inputIds,
          inputEpoch,
          destinationClaim: { generation: claimGeneration, claimId: `claim-${claimGeneration}` }
        },
        context()
      )
    return { adapter, input, handlers, retire }
  }

  it('writes once with a durable receipt, and does not replay after restart and reclaim', async () => {
    const first = setup()
    await expect(first.input()).resolves.toMatchObject({ outcome: 'applied', duplicate: false })
    expect(store.loadAll()[0]).toMatchObject({ version: 6, destinationInputJournal: true })
    await expect(first.input()).resolves.toMatchObject({ outcome: 'applied', duplicate: true })
    await expect(first.input('different')).rejects.toThrow('input_conflict')
    const restored = setup(3)
    await expect(restored.input()).resolves.toMatchObject({ outcome: 'applied', duplicate: true })
    expect(write).toHaveBeenCalledExactlyOnceWith(identity.terminalId, 'command\n')
    await expect(first.input('other', 'input-2', 1)).rejects.toThrow('input_unavailable')
  })

  it('does not report success or replay when PTY write throws', async () => {
    const fixture = setup()
    write.mockImplementation(() => {
      throw new Error('write outcome unknown')
    })
    await expect(fixture.input()).resolves.toMatchObject({
      outcome: 'unverifiable',
      duplicate: false
    })
    await expect(fixture.input()).resolves.toMatchObject({
      outcome: 'unverifiable',
      duplicate: true
    })
    await expect(setup(3).input()).resolves.toMatchObject({
      outcome: 'unverifiable',
      duplicate: true
    })
    expect(write).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'fences uncertain attempt persistence (written=%s) before any PTY write',
    async (written) => {
      const fixture = setup()
      failAt = saves + 1
      afterWrite = written
      await expect(fixture.input()).rejects.toThrow('uncertain input save')
      expect(write).not.toHaveBeenCalled()
      await expect(fixture.input()).rejects.toThrow('claim_unavailable')
      failAt = -1
      fixture.adapter.recoverDestination(request(), context())
      fixture.adapter.claimDestination(request(3), context())
      await expect(fixture.input('command\n', 'input-1', 3)).resolves.toMatchObject({
        outcome: 'unverifiable',
        duplicate: true
      })
      expect(write).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'does not repeat a write after uncertain completion persistence (written=%s)',
    async (written) => {
      const fixture = setup()
      failAt = saves + 2
      afterWrite = written
      await expect(fixture.input()).rejects.toThrow('uncertain input save')
      expect(write).toHaveBeenCalledOnce()
      failAt = -1
      await expect(setup(3).input()).resolves.toMatchObject({
        outcome: written ? 'applied' : 'unverifiable',
        duplicate: true
      })
      expect(write).toHaveBeenCalledOnce()
    }
  )

  it('keeps input unregistered without its gate', () => {
    expect(setup(2, false).handlers.has(PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD)).toBe(
      false
    )
  })

  it('frees a full window while rejecting all old-epoch retries after restart', async () => {
    const fixture = setup()
    await fixture.input()
    await fixture.input('second', 'input-2')
    await expect(fixture.input('third', 'input-3')).rejects.toThrow('input_capacity')
    await expect(fixture.retire(['input-1'])).rejects.toThrow('retirement_unacknowledged')
    await expect(fixture.retire(['input-1', 'input-1'])).rejects.toThrow('epoch_invalid')
    await expect(fixture.retire(['input-1', 'input-2'])).resolves.toMatchObject({
      inputEpoch: 1,
      retired: 2
    })
    expect(store.loadAll()[0]).toMatchObject({
      version: 7,
      destinationInputEpoch: 1,
      destinationInputs: []
    })
    const restored = setup(3)
    await expect(restored.input()).rejects.toThrow('epoch_stale')
    await expect(restored.retire(['input-1', 'input-2'])).rejects.toThrow('epoch_stale')
    expect(restored.adapter.inspectDestination(request(), context()).inputEpoch).toBe(1)
    await expect(restored.input('third', 'input-3', 3, 1)).resolves.toMatchObject({
      outcome: 'applied'
    })
    expect(write).toHaveBeenCalledTimes(3)
  })

  it('refuses to retire an uncertain input', async () => {
    const fixture = setup()
    write.mockImplementation(() => {
      throw new Error('uncertain write')
    })
    await fixture.input()
    await expect(fixture.retire(['input-1'])).rejects.toThrow('retirement_unacknowledged')
    expect(store.loadAll()[0].destinationInputEpoch).toBeUndefined()
  })

  it.each([false, true])(
    'fences uncertain epoch advancement until recovery (written=%s)',
    async (written) => {
      const fixture = setup()
      await fixture.input()
      failAt = saves + 1
      afterWrite = written
      await expect(fixture.retire(['input-1'])).rejects.toThrow('uncertain input save')
      await expect(fixture.input()).rejects.toThrow('claim_unavailable')
      failAt = -1
      fixture.adapter.recoverDestination(request(), context())
      fixture.adapter.claimDestination(request(3), context())
      await expect(fixture.input('command\n', 'input-1', 3)).rejects.toThrow('epoch_stale')
      expect(store.loadAll()[0]).toMatchObject({ version: 7, destinationInputEpoch: 1 })
      expect(write).toHaveBeenCalledOnce()
    }
  )
})
