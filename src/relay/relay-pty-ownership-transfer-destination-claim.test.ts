import {
  credential,
  identity,
  preparation,
  request,
  context,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  RelayPtyOwnershipTransferAdapter,
  RelayPtyOwnershipTransferAdapterOptions
} from './relay-pty-ownership-transfer-adapter'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import type { RelayDispatcher, MethodHandler } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD } from '../shared/pty-ownership-transfer-destination-claim'

describe('durable destination claims', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-destination-claim-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const relay = (patch: Partial<RelayPtyOwnershipTransferAdapterOptions> = {}) =>
    makeDelegatedRelay(store, patch)
  const active = (adapter: RelayPtyOwnershipTransferAdapter, ctx = context(), generation = 1) =>
    adapter.isDestinationClaimActive(identity, { generation, claimId: `claim-${generation}` }, ctx)

  it('uses a separate destination generation and persists no credential or socket binding', () => {
    const adapter = relay()
    adapter.prepare(preparation)
    const result = adapter.claimDestination(request(), context())
    expect(result).toMatchObject({ destinationGeneration: 1, sourceOwnerGeneration: 8 })
    expect(active(adapter)).toBe(true)
    expect(store.loadAll()[0]).toMatchObject({
      version: 3,
      destinationClaim: { generation: 1, claimId: 'claim-1' }
    })
    expect(JSON.stringify(store.loadAll())).not.toContain(credential)
    expect(store.loadAll()[0]).not.toHaveProperty('destinationClaimBinding')
  })

  it('retries only the same claim on its exact authenticated connection', () => {
    const adapter = relay()
    adapter.prepare(preparation)
    const result = adapter.claimDestination(request(), context())
    expect(adapter.claimDestination(request(), context())).toEqual(result)
    const otherPrincipal = {
      ...context(),
      sessionIdentity: { ...context().sessionIdentity!, principal: 'other' }
    }
    expect(active(adapter, otherPrincipal)).toBe(false)
    expect(() => adapter.claimDestination(request(), otherPrincipal)).toThrow('claim_stale')
    expect(() =>
      adapter.claimDestination({ ...request(), claimId: 'different' }, context())
    ).toThrow('claim_stale')
    expect(() => adapter.claimDestination(request(), context(3))).toThrow('claim_stale')
    expect(() => adapter.claimDestination(request(), context(2, 2))).toThrow('claim_stale')
  })

  it('fences an old still-live socket immediately when a successor claims', async () => {
    const adapter = relay()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    const delayedAdmission = Promise.resolve().then(() => active(adapter))
    adapter.claimDestination(request(2), context(3))
    expect(await delayedAdmission).toBe(false)
    expect(active(adapter, context(3), 2)).toBe(true)
    expect(() => adapter.claimDestination(request(), context())).toThrow('claim_stale')
  })

  it('restores the generation but requires a new claim after reopening the journal', () => {
    const first = relay()
    first.prepare(preparation)
    first.claimDestination(request(), context())
    const restored = relay()
    expect(active(restored)).toBe(false)
    expect(() => restored.claimDestination(request(), context())).toThrow('claim_stale')
    restored.claimDestination(request(2), context(3))
    expect(active(restored, context(3), 2)).toBe(true)
  })

  it.each([
    { credential: 'f'.repeat(64) },
    { destinationRuntimeId: 'wrong-host' },
    { incarnationId: 'wrong-incarnation' },
    { ownerLease: 'other-lease' },
    { sourceOwnerGeneration: 9 },
    { previousDestinationGeneration: 2, destinationGeneration: 3 }
  ])('rejects wrong proof, identity, or predecessor %#', (patch) => {
    const adapter = relay()
    adapter.prepare(preparation)
    expect(() => adapter.claimDestination({ ...request(), ...patch }, context())).toThrow()
    expect(store.loadAll()[0]).not.toHaveProperty('destinationClaim')
  })

  it.each([
    { sessionIdentity: undefined },
    { transportGeneration: undefined },
    { transportGeneration: -1 },
    { clientId: 0 },
    { isStale: () => true },
    { sessionIdentity: { ...context().sessionIdentity!, authenticated: false } },
    {
      sessionIdentity: {
        ...context().sessionIdentity!,
        authenticationKind: 'launch-nonce' as const
      }
    }
  ])('rejects an unauthenticated or stale binding %#', (patch) => {
    const adapter = relay()
    adapter.prepare(preparation)
    expect(() => adapter.claimDestination(request(), { ...context(), ...patch })).toThrow(
      'claim_unauthorized'
    )
  })

  it.each([false, true])('fences all bindings when save fails (record written: %s)', (written) => {
    let failWrite = false
    const adapter = relay({
      store: {
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
      }
    })
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    failWrite = true
    expect(() => adapter.claimDestination(request(2), context(3))).toThrow('uncertain write')
    expect(active(adapter)).toBe(false)
    expect(active(adapter, context(3), 2)).toBe(false)
    failWrite = false
    expect(() => adapter.claimDestination(request(2), context(3))).toThrow('claim_unavailable')
    adapter.observeOutput('pty-1', 'still alive')
    expect(store.loadAll()[0].destinationClaim?.generation).toBe(2)
    expect(active(adapter, context(3), 2)).toBe(false)
    const restored = relay()
    restored.claimDestination(request(3), context(4))
    expect(active(restored, context(4), 3)).toBe(true)
  })

  it('does not bind a socket that becomes stale during persistence', () => {
    let stale = false
    const adapter = relay({
      store: {
        loadAll: () => store.loadAll(),
        remove: (id) => store.remove(id),
        save: (record) => {
          store.save(record)
          if (record.destinationClaim) {
            stale = true
          }
        }
      }
    })
    adapter.prepare(preparation)
    expect(() =>
      adapter.claimDestination(request(), { ...context(), isStale: () => stale })
    ).toThrow('claim_unauthorized')
    expect(active(adapter)).toBe(false)
    expect(store.loadAll()[0].destinationClaim?.generation).toBe(1)
  })

  it('clears detached bindings and registers claims only with the disabled-by-default gate', async () => {
    const handlers = new Map<string, MethodHandler>()
    let detached: ((id: number) => void) | undefined
    const dispatcher = {
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
      onClientDetached: (listener: (id: number) => void) => {
        detached = listener
      }
    } as unknown as RelayDispatcher
    relay({ enableDestinationDelegationClaims: undefined }).register(dispatcher)
    expect(handlers.has(PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD)).toBe(false)
    const adapter = relay()
    adapter.prepare(preparation)
    adapter.register(dispatcher)
    await handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD)!(request(), context())
    expect(active(adapter)).toBe(true)
    detached!(2)
    expect(active(adapter)).toBe(false)
    expect(() => adapter.claimDestination(request(), context())).toThrow('claim_stale')
  })

  it('rejects claims after an authenticated source abort', () => {
    const adapter = relay()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    adapter.abort(preparation)
    expect(active(adapter)).toBe(false)
    expect(() => adapter.claimDestination(request(2), context(3))).toThrow('claim_unavailable')
  })

  it.each(['v2-claim', 'v3-no-claim', 'bad-generation'] as const)(
    'rejects corrupt durable claim %s',
    (corruption) => {
      const adapter = relay()
      adapter.prepare(preparation)
      adapter.claimDestination(request(), context())
      const record = { ...store.loadAll()[0] }
      if (corruption === 'v2-claim') {
        record.version = 2
      }
      if (corruption === 'v3-no-claim') {
        delete record.destinationClaim
      }
      if (corruption === 'bad-generation') {
        record.destinationClaim = { generation: 0, claimId: 'claim-1' }
      }
      expect(() =>
        relay({ store: { loadAll: () => [record], save: () => {}, remove: () => {} } })
      ).toThrow('journal_invalid')
    }
  )
})
