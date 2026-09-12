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
import type { RelayDispatcher, MethodHandler } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD } from '../shared/pty-ownership-transfer-destination-claim'

const proof = { version: 1, ...identity, credential }
describe('authenticated destination generation discovery', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-destination-status-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('reports no claim before first admission without writing or granting authority', () => {
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    const save = vi.spyOn(store, 'save')
    expect(adapter.inspectDestination(proof, context())).toMatchObject({
      phase: 'prepared',
      destinationClaim: null,
      boundToConnection: false
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('discovers the durable generation after lost response/restart and permits exact successor claim', () => {
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    expect(adapter.inspectDestination(proof, context()).boundToConnection).toBe(true)
    const restored = makeDelegatedRelay(store)
    const status = restored.inspectDestination(proof, context(3))
    expect(status).toMatchObject({
      phase: 'prepared',
      destinationClaim: { generation: 1, claimId: 'claim-1' },
      boundToConnection: false
    })
    expect(JSON.stringify(status)).not.toContain(credential)
    expect(status).not.toHaveProperty('destinationDelegation')
    restored.claimDestination(request(status.destinationClaim!.generation + 1), context(3))
    expect(restored.inspectDestination(proof, context(3)).boundToConnection).toBe(true)
  })

  it('inspects terminal metadata only for the live connection holding the claim', () => {
    const info = { pid: 42, cols: 103, rows: 37, initialCwd: '/srv/work' }
    const inspectDestinationTerminal = vi.fn(() => info)
    const adapter = makeDelegatedRelay(store, {
      resolveTerminalIncarnation: () => identity.incarnationId,
      inspectDestinationTerminal
    })
    adapter.prepare(preparation)
    expect(adapter.inspectDestination(proof, context())).not.toHaveProperty('terminalInfo')
    expect(inspectDestinationTerminal).not.toHaveBeenCalled()
    adapter.claimDestination(request(), context())
    expect(adapter.inspectDestination(proof, context(3))).not.toHaveProperty('terminalInfo')
    expect(adapter.inspectDestination(proof, context(2, 2))).not.toHaveProperty('terminalInfo')
    expect(inspectDestinationTerminal).not.toHaveBeenCalled()

    const status = adapter.inspectDestination(proof, context())
    expect(inspectDestinationTerminal).toHaveBeenCalledExactlyOnceWith(identity)
    expect(status.terminalInfo).toEqual(info)
    expect(status.terminalInfo).not.toBe(info)
    expect(Object.isFrozen(status.terminalInfo)).toBe(true)
    adapter.abort(preparation)
    expect(adapter.inspectDestination(proof, context())).not.toHaveProperty('terminalInfo')
    expect(inspectDestinationTerminal).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'replacement', 'probe-failure'])(
    'does not inspect terminal metadata when incarnation is %s',
    (mode) => {
      const inspectDestinationTerminal = vi.fn()
      const adapter = makeDelegatedRelay(store, {
        resolveTerminalIncarnation: () => {
          if (mode === 'probe-failure') {
            throw new Error('probe unavailable')
          }
          return mode === 'missing' ? null : 'replacement-incarnation'
        },
        inspectDestinationTerminal
      })
      adapter.prepare(preparation)
      adapter.claimDestination(request(), context())
      const status = adapter.inspectDestination(proof, context())
      expect(status.executionVerdict).toBe('unverifiable')
      expect(status).not.toHaveProperty('terminalInfo')
      expect(inspectDestinationTerminal).not.toHaveBeenCalled()
    }
  )

  it('does not rebind or displace another live connection during discovery', () => {
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    const before = store.loadAll()
    expect(adapter.inspectDestination(proof, context(3)).boundToConnection).toBe(false)
    expect(adapter.inspectDestination(proof, context()).boundToConnection).toBe(true)
    expect(store.loadAll()).toEqual(before)
  })

  it('reveals an aborted grant but cannot revive it', () => {
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    adapter.abort(preparation)
    expect(adapter.inspectDestination(proof, context())).toMatchObject({
      phase: 'aborted',
      destinationClaim: { generation: 1 },
      boundToConnection: false
    })
    expect(() => adapter.claimDestination(request(2), context())).toThrow('claim_unavailable')
  })

  it.each([false, true])(
    'refuses a guessed generation after an uncertain write (written: %s)',
    (written) => {
      let failWrite = false
      const adapter = makeDelegatedRelay({
        loadAll: () => store.loadAll(),
        remove: (id) => store.remove(id),
        save: (record) => {
          if (!failWrite || written) {
            store.save(record)
          }
          if (failWrite) {
            throw new Error('uncertain write')
          }
        }
      })
      adapter.prepare(preparation)
      failWrite = true
      expect(() => adapter.claimDestination(request(), context())).toThrow('uncertain write')
      expect(() => adapter.inspectDestination(proof, context())).toThrow('claim_unavailable')
      const restored = makeDelegatedRelay(store)
      expect(restored.inspectDestination(proof, context()).destinationClaim?.generation ?? 0).toBe(
        written ? 1 : 0
      )
    }
  )

  it.each([
    { credential: 'f'.repeat(64) },
    { credential: undefined },
    { destinationRuntimeId: 'wrong' },
    { ownerLease: 'wrong' }
  ])('requires exact identity and capability %#', (patch) => {
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    expect(() => adapter.inspectDestination({ ...proof, ...patch }, context())).toThrow()
  })

  it('refuses stale, unauthenticated and disabled discovery', () => {
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    expect(() => adapter.inspectDestination(proof, { ...context(), isStale: () => true })).toThrow(
      'claim_unauthorized'
    )
    expect(() =>
      adapter.inspectDestination(proof, { ...context(), sessionIdentity: undefined })
    ).toThrow('claim_unauthorized')
    expect(() =>
      makeDelegatedRelay(store, { enableDestinationDelegationClaims: false }).inspectDestination(
        proof,
        context()
      )
    ).toThrow('claim_unavailable')
  })

  it('registers discovery only with the claim gate, independently of source-owner status', async () => {
    const handlers = new Map<string, MethodHandler>()
    const dispatcher = {
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
    } as unknown as RelayDispatcher
    makeDelegatedRelay(store, { enableDestinationDelegationClaims: undefined }).register(dispatcher)
    expect(handlers.has(PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD)).toBe(false)
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    adapter.register(dispatcher)
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD)!(proof, context())
    ).resolves.toMatchObject({ destinationClaim: null })
  })
})
