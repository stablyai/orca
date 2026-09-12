import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RelayPtyOwnershipTransferAdapter,
  type RelayPtyOwnershipTransferAdapterOptions
} from './relay-pty-ownership-transfer-adapter'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import { parsePtyOwnershipTransferPrepareRequest } from '../shared/pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../shared/pty-ownership-transfer-wire'
import type { MethodHandler, RelayDispatcher } from './dispatcher'

const source = {
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'source-lease',
  sourceOwnerGeneration: 4
}
const credential = 'destination-private-capability'.padEnd(64, 'x')
const delegation = {
  version: 1 as const,
  credentialSha256: createHash('sha256').update(credential).digest('hex')
}
const request = {
  version: 1 as const,
  ...source,
  bridgeId: 'bridge-1',
  destinationRuntimeId: 'host-orcad',
  destinationDelegation: delegation,
  surfacePublication: {
    version: 1 as const,
    surfaceBinding: {
      executionHostId: 'local' as const,
      workspaceKey: 'folder:folder-1' as const,
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'pty-1'
    }
  }
}

describe('dormant destination delegation preparation', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  const fence = vi.fn()
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-delegation-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
    fence.mockReset()
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  const adapter = (patch: Partial<RelayPtyOwnershipTransferAdapterOptions> = {}) =>
    new RelayPtyOwnershipTransferAdapter({
      store,
      enableDestinationDelegationPreparation: true,
      resolveSource: () => source,
      authorizeRequest: () => false,
      setInputFenced: fence,
      writeDestinationInput: () => {},
      publishDestinationOutput: () => {},
      ...patch
    })

  it('persists only the digest with the exact identity and host-local surface', () => {
    expect(adapter().prepare(request)).toMatchObject({ destinationDelegation: delegation })
    const records = store.loadAll()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      version: 2,
      destinationDelegation: delegation,
      identity: { ...source, bridgeId: 'bridge-1', destinationRuntimeId: 'host-orcad' },
      surfacePublication: request.surfacePublication,
      phase: 'prepared'
    })
    expect(JSON.stringify(records)).not.toContain(credential)
    expect(fence).toHaveBeenCalledWith('pty-1', true)
  })

  it('retries after a lost prepare response and after reopening the durable store', () => {
    const first = adapter()
    const result = first.prepare(request)
    expect(first.prepare(request)).toEqual(result)
    store = new RelayPtyOwnershipTransferFileStore(directory)
    expect(adapter().prepare(request)).toEqual(result)
    expect(store.loadAll()).toHaveLength(1)
  })

  it('reflushes exact prepare retries, including after reopening durable state', () => {
    const save = vi.spyOn(store, 'save')
    const relay = adapter()
    const result = relay.prepare(request)
    expect(save).toHaveBeenCalledTimes(1)
    expect(relay.prepare(request)).toEqual(result)
    expect(save).toHaveBeenCalledTimes(2)
    expect(adapter().prepare(request)).toEqual(result)
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('retains the fence and requires authenticated recovery after retry persistence fails', () => {
    const relay = adapter()
    relay.prepare(request)
    const before = store.loadAll()
    const save = vi.spyOn(store, 'save').mockImplementationOnce(() => {
      throw new Error('retry fsync failed')
    })
    expect(() => relay.prepare(request)).toThrow('retry fsync failed')
    expect(() => relay.prepare(request)).toThrow('delegation_write_unverifiable')
    expect(save).toHaveBeenCalledOnce()
    expect(store.loadAll()).toEqual(before)
    expect(fence.mock.calls).toEqual([['pty-1', true]])
  })

  it.each([
    { destinationDelegation: undefined },
    { destinationDelegation: { version: 1, credentialSha256: 'f'.repeat(64) } },
    { destinationRuntimeId: 'other-host' },
    { incarnationId: 'other-incarnation' },
    { ownerLease: 'other-lease' },
    { sourceOwnerGeneration: 5 },
    {
      surfacePublication: {
        ...request.surfacePublication,
        surfaceBinding: {
          ...request.surfacePublication.surfaceBinding,
          workspaceKey: 'folder:other-folder'
        }
      }
    }
  ])('rejects changed delegation or identity on retry %#', (patch) => {
    const relay = adapter()
    relay.prepare(request)
    const before = store.loadAll()
    expect(() => relay.prepare({ ...request, ...patch })).toThrow()
    expect(store.loadAll()).toEqual(before)
  })

  it('requires the preparation gate and durable storage before fencing the source', () => {
    expect(() =>
      adapter({ enableDestinationDelegationPreparation: undefined }).prepare(request)
    ).toThrow('delegation_unavailable')
    expect(() =>
      adapter({ enableDestinationDelegationPreparation: false }).prepare(request)
    ).toThrow('delegation_unavailable')
    expect(() => adapter({ store: undefined }).prepare(request)).toThrow('delegation_unavailable')
    expect(fence).not.toHaveBeenCalled()
    expect(store.loadAll()).toEqual([])
  })

  it('does not let a requesting non-owner prepare a delegation over RPC', async () => {
    const handlers = new Map<string, MethodHandler>()
    adapter().register({
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
    } as unknown as RelayDispatcher)
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)!(request, {
        clientId: 9,
        transportGeneration: 1,
        isStale: () => false,
        sessionIdentity: {
          principal: 'host-local',
          authenticated: true,
          allowSessionOwner: false,
          authenticationKind: 'endpoint-credential'
        }
      })
    ).rejects.toThrow('not authorized')
    expect(fence).not.toHaveBeenCalled()
    expect(store.loadAll()).toEqual([])
  })

  it('rejects stale live source identity before recording a grant', () => {
    expect(() =>
      adapter({ resolveSource: () => ({ ...source, sourceOwnerGeneration: 5 }) }).prepare(request)
    ).toThrow()
    expect(fence).not.toHaveBeenCalled()
    expect(store.loadAll()).toEqual([])
  })

  it.each([false, true])(
    'retains the source fence after uncertain prepare (written: %s)',
    (written) => {
      let failWrite = true
      const relay = adapter({
        store: {
          loadAll: () => [],
          save: (record) => {
            if (written || !failWrite) {
              store.save(record)
            }
            if (failWrite) {
              throw new Error('disk full')
            }
          },
          remove: () => {}
        }
      })
      expect(() => relay.prepare(request)).toThrow('disk full')
      expect(relay.snapshot('bridge-1')).toMatchObject({ phase: 'prepared' })
      expect(fence.mock.calls).toEqual([['pty-1', true]])
      expect(() => relay.prepare(request)).toThrow('delegation_write_unverifiable')
      failWrite = false
      expect(relay.abort(request)).toMatchObject({ phase: 'aborted' })
      expect(store.loadAll()[0].phase).toBe('aborted')
      expect(fence).toHaveBeenLastCalledWith('pty-1', false)
    }
  )

  it('allows precommit abort after restart without reopening delegation preparation', () => {
    adapter().prepare(request)
    const restored = adapter({ enableDestinationDelegationPreparation: false })
    expect(restored.abort(request)).toMatchObject({ phase: 'aborted' })
    expect(store.loadAll()[0]).toMatchObject({
      version: 2,
      phase: 'aborted',
      destinationDelegation: delegation
    })
    expect(() => adapter().prepare(request)).toThrow('aborted')
    expect(fence).toHaveBeenLastCalledWith('pty-1', false)
  })

  it('refuses delegated commit while destination claim and routing remain unavailable', () => {
    const relay = adapter()
    relay.prepare(request)
    expect(() =>
      relay.commit({
        ...request,
        acceptedSourceEndSeq: 0,
        receipt: {
          receiptId: 'receipt-1',
          bridgeId: 'bridge-1',
          acceptedSourceEndSeq: 0,
          committedAt: '2026-09-06T00:00:00.000Z'
        }
      })
    ).toThrow('delegation_commit_unavailable')
    expect(store.loadAll()[0].phase).toBe('prepared')
  })

  it('retains version-one records for ordinary transfers', () => {
    adapter({ enableDestinationDelegationPreparation: false }).prepare({
      ...request,
      destinationDelegation: undefined
    })
    expect(store.loadAll()[0]).toMatchObject({ version: 1 })
    expect(store.loadAll()[0]).not.toHaveProperty('destinationDelegation')
  })

  it.each(['v1-grant', 'v2-no-grant', 'bad-digest', 'committed-grant'] as const)(
    'rejects inconsistent durable record %s',
    (corruption) => {
      adapter().prepare(request)
      const record = { ...structuredClone(store.loadAll()[0]) }
      if (corruption === 'v1-grant') {
        record.version = 1
      }
      if (corruption === 'v2-no-grant') {
        delete record.destinationDelegation
      }
      if (corruption === 'bad-digest') {
        record.destinationDelegation = { version: 1, credentialSha256: 'bad' }
      }
      if (corruption === 'committed-grant') {
        record.phase = 'committed'
      }
      expect(() =>
        adapter({ store: { loadAll: () => [record], save: () => {}, remove: () => {} } })
      ).toThrow('journal_invalid')
    }
  )

  it.each([
    null,
    {},
    { version: 2, credentialSha256: 'a'.repeat(64) },
    { version: 1, credentialSha256: 'A'.repeat(64) }
  ])('rejects malformed delegation %#', (destinationDelegation) => {
    expect(() =>
      parsePtyOwnershipTransferPrepareRequest({ ...request, destinationDelegation })
    ).toThrow('delegation_invalid')
  })

  it('requires a host-local destination surface', () => {
    expect(() =>
      parsePtyOwnershipTransferPrepareRequest({ ...request, surfacePublication: undefined })
    ).toThrow('host_local_surface')
  })
})
