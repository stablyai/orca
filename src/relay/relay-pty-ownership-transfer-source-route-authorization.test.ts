import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../shared/pty-ownership-transfer-wire'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  context,
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'

describe('delegated destination excludes legacy source mutation routes', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-source-route-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function setup(authorizeRequest: () => boolean | Promise<boolean> = () => true) {
    const writeDestinationInput = vi.fn()
    const applyDestinationControl = vi.fn(() => 'applied' as const)
    const adapter = makeDelegatedRelay(store, {
      authorizeRequest,
      writeDestinationInput,
      applyDestinationControl
    })
    const handlers = new Map<string, MethodHandler>()
    adapter.register({
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
    } as unknown as RelayDispatcher)
    return { adapter, handlers, writeDestinationInput, applyDestinationControl }
  }

  it.each([
    'commit',
    'publish',
    'input',
    'retireInput',
    'attach',
    'rekeyReconnect',
    'control'
  ] as const)('rejects source-authorized %s without changing the journal', async (method) => {
    const { adapter, handlers, writeDestinationInput, applyDestinationControl } = setup()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    const before = store.loadAll()
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS[method])!(preparation, context())
    ).rejects.toThrow('delegated_destination_route_required')
    expect(store.loadAll()).toEqual(before)
    expect(writeDestinationInput).not.toHaveBeenCalled()
    expect(applyDestinationControl).not.toHaveBeenCalled()
  })

  it('checks the delegation after awaited source authorization', async () => {
    let authorize: ((value: boolean) => void) | undefined
    const { adapter, handlers } = setup(
      () =>
        new Promise<boolean>((resolve) => {
          authorize = resolve
        })
    )
    const pending = handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.attach)!(preparation, context())
    adapter.prepare(preparation)
    authorize!(true)
    await expect(pending).rejects.toThrow('delegated_destination_route_required')
  })

  it('retains source recovery reads and prepared abort without granting destination authority', async () => {
    const { adapter, handlers } = setup()
    adapter.prepare(preparation)
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.status)!(preparation, context())
    ).resolves.toMatchObject({ phase: 'prepared' })
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.replay)!(
        { ...preparation, afterSeq: 0 },
        context()
      )
    ).resolves.toMatchObject({ phase: 'prepared', frames: [] })
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.abort)!(preparation, context())
    ).resolves.toMatchObject({ phase: 'aborted' })
  })

  it('leaves ordinary source-owner attachment unchanged', async () => {
    const { adapter, handlers } = setup()
    adapter.prepare({ ...preparation, destinationDelegation: undefined })
    await expect(
      handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.attach)!(
        { ...preparation, attachmentId: 'legacy-attachment' },
        context()
      )
    ).resolves.toMatchObject({ attachmentId: 'legacy-attachment' })
  })

  it('also fences direct operation calls without touching journal or terminal', async () => {
    const { adapter, writeDestinationInput, applyDestinationControl } = setup()
    adapter.prepare(preparation)
    const before = store.loadAll()
    const attachment = { ...preparation, attachmentId: 'legacy-attachment' }
    const receipt = {
      bridgeId: preparation.bridgeId,
      receiptId: 'receipt-1',
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
    for (const mutate of [
      () => adapter.attach(attachment, context()),
      () => adapter.acceptInput({ ...preparation, inputId: 'input-1', data: 'dangerous' }),
      () => adapter.retireInput({ ...preparation, inputIds: ['input-1'] }),
      () =>
        adapter.rekeyReconnect(
          { ...attachment, previousReconnectGeneration: 8, reconnectGeneration: 9 },
          context()
        ),
      () =>
        adapter.publish({
          ...preparation,
          publicationReceipt: {
            version: 1,
            bridgeId: preparation.bridgeId,
            destinationRuntimeId: preparation.destinationRuntimeId,
            publicationReceiptId: 'publication-1',
            publishedAt: '2026-09-06T00:00:00.000Z',
            commitReceipt: receipt,
            surfaceBinding: preparation.surfacePublication.surfaceBinding
          }
        })
    ]) {
      expect(mutate).toThrow('delegated_destination_route_required')
    }
    await expect(
      adapter.control(
        {
          ...attachment,
          controlId: 'control-1',
          control: {
            kind: 'resize',
            cols: 80,
            rows: 24
          }
        },
        context()
      )
    ).rejects.toThrow('delegated_destination_route_required')
    expect(() => adapter.commit({ ...preparation, acceptedSourceEndSeq: 0, receipt })).toThrow(
      'delegation_commit_unavailable'
    )
    expect(store.loadAll()).toEqual(before)
    expect(writeDestinationInput).not.toHaveBeenCalled()
    expect(applyDestinationControl).not.toHaveBeenCalled()
  })
})
