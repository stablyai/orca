import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterOptions } from './relay-pty-ownership-transfer-adapter-contract'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD } from '../shared/pty-ownership-transfer-destination-control'

describe('claim-bound delegated controls', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  let failAt: number
  let saves: number
  let written: boolean
  const apply =
    vi.fn<NonNullable<RelayPtyOwnershipTransferAdapterOptions['applyDestinationControl']>>()
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-delegated-control-'))
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
        receiptId: 'receipt',
        acceptedSourceEndSeq: 0,
        committedAt: '2026-09-06T00:00:00.000Z'
      }
    })
    failAt = -1
    saves = 0
    written = false
    apply.mockReset().mockReturnValue('applied')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function setup(generation = 2, enabled = true) {
    const adapter = makeDelegatedRelay(
      {
        loadAll: () => store.loadAll(),
        remove: (id) => store.remove(id),
        save: (record) => {
          saves++
          if (saves !== failAt || written) {
            store.save(record)
          }
          if (saves === failAt) {
            throw new Error('uncertain control save')
          }
        }
      },
      {
        enableDestinationDelegationControl: enabled,
        resolveSource: () => null,
        resolveTerminalIncarnation: () => identity.incarnationId,
        applyDestinationControl: apply
      }
    )
    adapter.claimDestination(request(generation), context())
    const handlers = new Map<string, MethodHandler>()
    adapter.register({
      onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler)
    } as unknown as RelayDispatcher)
    const control = (controlId = 'control-1', claimGeneration = generation, cols = 100) =>
      handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD)!(
        {
          ...request(claimGeneration),
          controlId,
          control: { kind: 'resize', cols, rows: 30 },
          destinationClaim: { generation: claimGeneration, claimId: `claim-${claimGeneration}` }
        },
        context()
      )
    return { adapter, control, handlers }
  }

  it('records completion and never repeats a control after restart/reclaim', async () => {
    const fixture = setup()
    await expect(fixture.control()).resolves.toMatchObject({ outcome: 'applied', duplicate: false })
    expect(store.loadAll()[0]).toMatchObject({ version: 8, destinationControlJournal: true })
    await expect(setup(3).control()).resolves.toMatchObject({ outcome: 'applied', duplicate: true })
    expect(apply).toHaveBeenCalledOnce()
    await expect(fixture.control('control-1', 2, 120)).rejects.toThrow('control_conflict')
  })

  it('does not repeat an in-flight control and rechecks ownership before host mutation', async () => {
    let resume!: () => void
    const wait = new Promise<void>((resolve) => {
      resume = resolve
    })
    const mutate = vi.fn()
    apply.mockImplementation(async (_identity, _control, isAuthorized) => {
      await wait
      if (!isAuthorized?.()) {
        return 'unverifiable'
      }
      mutate()
      return 'applied'
    })
    const fixture = setup()
    const pending = fixture.control()
    await expect(fixture.control()).resolves.toMatchObject({
      outcome: 'unverifiable',
      duplicate: true
    })
    fixture.adapter.claimDestination(request(3), context())
    resume()
    await expect(pending).resolves.toMatchObject({ outcome: 'unverifiable' })
    await expect(fixture.control('control-1', 3)).resolves.toMatchObject({
      outcome: 'unverifiable',
      duplicate: true
    })
    expect(mutate).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledOnce()
  })

  it('preserves uncertain host failure instead of treating it as success', async () => {
    apply.mockRejectedValue(new Error('signal may have been sent'))
    const fixture = setup()
    await expect(fixture.control()).resolves.toMatchObject({ outcome: 'unverifiable' })
    await expect(setup(3).control()).resolves.toMatchObject({
      outcome: 'unverifiable',
      duplicate: true
    })
    expect(apply).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'fences uncertain attempt save before host mutation (written=%s)',
    async (after) => {
      const fixture = setup()
      failAt = saves + 1
      written = after
      await expect(fixture.control()).rejects.toThrow('uncertain control save')
      expect(apply).not.toHaveBeenCalled()
      await expect(fixture.control()).rejects.toThrow('claim_unavailable')
      failAt = -1
      fixture.adapter.recoverDestination(request(), context())
      fixture.adapter.claimDestination(request(3), context())
      await expect(fixture.control('control-1', 3)).resolves.toMatchObject({
        outcome: 'unverifiable',
        duplicate: true
      })
    }
  )

  it.each([false, true])(
    'does not repeat after uncertain completion save (written=%s)',
    async (after) => {
      const fixture = setup()
      failAt = saves + 2
      written = after
      await expect(fixture.control()).rejects.toThrow('uncertain control save')
      expect(apply).toHaveBeenCalledOnce()
      failAt = -1
      await expect(setup(3).control()).resolves.toMatchObject({
        outcome: after ? 'applied' : 'unverifiable',
        duplicate: true
      })
      expect(apply).toHaveBeenCalledOnce()
    }
  )

  it('does not register without the control gate', () => {
    expect(setup(2, false).handlers.has(PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD)).toBe(
      false
    )
  })
})
