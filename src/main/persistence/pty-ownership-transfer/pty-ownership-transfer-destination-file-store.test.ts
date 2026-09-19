import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PtyOwnershipTransferDestinationAdapter,
  type PtyOwnershipTransferDestinationPublicationRequest,
  type PtyOwnershipTransferDestinationStore
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferIdentity
} from '../../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferPrepareResult } from '../../../shared/pty-ownership-transfer-wire'
import { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'

const identity: PtyOwnershipTransferIdentity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
}

const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'terminal-1'
}

const prepareResult: PtyOwnershipTransferPrepareResult = {
  ...identity,
  version: 1,
  phase: 'prepared',
  sourceOutputEndSeq: 2,
  replayStartSeq: 1,
  surfacePublication: { version: 1, surfaceBinding }
}

const commitReceipt: PtyOwnershipTransferCommitReceipt = {
  receiptId: 'commit-1',
  bridgeId: identity.bridgeId,
  acceptedSourceEndSeq: 2,
  committedAt: '2026-08-30T12:01:00.000Z'
}

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-transfer-destination-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function createStore(options: { maxRecords?: number; maxInputIds?: number } = {}) {
  return new PtyOwnershipTransferDestinationFileStore({
    directory,
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    ...options
  })
}

function createAdapter(
  store: PtyOwnershipTransferDestinationStore,
  publishDurably = vi.fn(
    (request: PtyOwnershipTransferDestinationPublicationRequest) => request.publicationReceipt
  )
) {
  return {
    adapter: new PtyOwnershipTransferDestinationAdapter({
      store,
      inputIds: 2,
      publishDurably,
      publishPostCommitOutput: () => {}
    }),
    publishDurably
  }
}

describe('PtyOwnershipTransferDestinationFileStore', () => {
  it('recovers staged frames, receipts, and input IDs after process restarts', () => {
    const first = createAdapter(createStore())
    first.adapter.prepare(prepareResult)
    first.adapter.bindSurface(surfaceBinding)
    first.adapter.acceptReplayFrame({ seq: 1, data: 'first\n' })

    const second = createAdapter(createStore())
    expect(second.adapter.prepare(prepareResult)).toMatchObject({
      phase: 'prepared',
      acceptedSourceEndSeq: 1,
      stagedOutputFrames: 1,
      surfaceBinding
    })
    second.adapter.acceptReplayFrame({ seq: 2, data: 'second\n' })
    second.adapter.commit(commitReceipt)

    const third = createAdapter(createStore())
    expect(third.adapter.prepare(prepareResult).phase).toBe('committed')
    const publicationReceipt = third.adapter.publish()
    expect(publicationReceipt).toMatchObject({
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      commitReceipt,
      surfaceBinding
    })
    expect(third.publishDurably).toHaveBeenCalledWith({
      identity,
      surfaceBinding,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ],
      publicationReceipt
    })
    expect(third.adapter.acceptInput('input-1', 'ls\n')).toEqual({
      accepted: true,
      duplicate: false
    })

    const fourth = createAdapter(createStore())
    expect(fourth.adapter.prepare(prepareResult).phase).toBe('published')
    expect(fourth.adapter.publish()).toEqual(publicationReceipt)
    expect(fourth.publishDurably).not.toHaveBeenCalled()
    expect(fourth.adapter.acceptInput('input-1', 'ls\n')).toEqual({
      accepted: false,
      duplicate: true
    })
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('fails closed on an identity conflict or corrupt durable record', () => {
    const store = createStore()
    store.prepare(identity, 0)
    expect(() => store.load({ ...identity, ownerLease: 'other-lease' })).toThrow(
      'pty_ownership_transfer_destination_store_invalid'
    )

    const recordFile = readdirSync(directory).find((name) => name.endsWith('.json'))
    writeFileSync(join(directory, recordFile!), '{', 'utf8')
    expect(() => createStore().load(identity)).toThrow(
      'pty_ownership_transfer_destination_store_invalid'
    )
  })

  it('fails closed when a recovered transfer is rebound to another workspace surface', () => {
    const first = createAdapter(createStore())
    first.adapter.prepare(prepareResult)
    first.adapter.bindSurface(surfaceBinding)

    const recovered = createAdapter(createStore())
    expect(() =>
      recovered.adapter.prepare({
        ...prepareResult,
        surfacePublication: {
          version: 1,
          surfaceBinding: { ...surfaceBinding, tabId: 'other-tab' }
        }
      })
    ).toThrow(expect.objectContaining({ reason: 'surface-conflict' }))
    recovered.adapter.prepare(prepareResult)
    expect(() =>
      recovered.adapter.bindSurface({
        ...surfaceBinding,
        workspaceKey: 'worktree:repo-1::/workspace'
      })
    ).toThrow(expect.objectContaining({ reason: 'surface-conflict' }))
    expect(createStore().loadSurfaceBinding(identity)).toEqual(surfaceBinding)
  })

  it('reuses a reserved receipt after model publication wins a crash race', () => {
    const baseStore = createStore()
    let failPublish = true
    const store = new Proxy(baseStore, {
      get(target, property, receiver) {
        if (property === 'publish') {
          return (...args: Parameters<PtyOwnershipTransferDestinationStore['publish']>) => {
            if (failPublish) {
              failPublish = false
              throw new Error('simulated_destination_journal_crash')
            }
            return target.publish(...args)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as PtyOwnershipTransferDestinationStore
    let modelReceipt: ReturnType<
      PtyOwnershipTransferDestinationStore['reservePublication']
    > | null = null
    const publishDurably = vi.fn((request: PtyOwnershipTransferDestinationPublicationRequest) => {
      if (
        modelReceipt &&
        JSON.stringify(modelReceipt) !== JSON.stringify(request.publicationReceipt)
      ) {
        throw new Error('model_publication_receipt_conflict')
      }
      modelReceipt = request.publicationReceipt
      return request.publicationReceipt
    })
    const first = createAdapter(store, publishDurably)
    first.adapter.prepare(prepareResult)
    first.adapter.bindSurface(surfaceBinding)
    first.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    first.adapter.commit(commitReceipt)
    expect(() => first.adapter.publish()).toThrow('simulated_destination_journal_crash')

    const recovered = createAdapter(createStore(), publishDurably)
    expect(recovered.adapter.prepare(prepareResult).phase).toBe('committed')
    expect(recovered.adapter.publish()).toEqual(modelReceipt)
    expect(publishDurably).toHaveBeenCalledTimes(2)
  })

  it('does not advance its durable cursor when a direct caller skips output', () => {
    const store = createStore()
    store.prepare(identity, 0)
    expect(() => store.appendFrame(identity, { seq: 2, data: 'gap\n' })).toThrow(
      'pty_ownership_transfer_destination_output_gap'
    )
    expect(createStore().load(identity)).toMatchObject({ acceptedSourceEndSeq: 0 })
    expect(createStore().loadFrames(identity)).toEqual([])
  })

  it('retains completed receipts and refuses capacity instead of evicting retry state', () => {
    const store = createStore({ maxRecords: 1 })
    store.prepare(identity, 0)
    expect(() =>
      store.prepare({ ...identity, bridgeId: 'bridge-2', terminalId: 'terminal-2' }, 0)
    ).toThrow('pty_ownership_transfer_destination_store_capacity_exceeded')
    expect(createStore().load(identity)).toMatchObject({ bridgeId: identity.bridgeId })
  })

  it('enumerates bounded active recovery candidates without mutating them', () => {
    const store = createStore()
    store.prepare(identity, 0)
    const abortedIdentity = { ...identity, bridgeId: 'bridge-aborted' }
    store.prepare(abortedIdentity, 0)
    store.abort(abortedIdentity)

    expect(createStore().listRecoveryCandidates()).toEqual([
      {
        journal: expect.objectContaining({
          bridgeId: identity.bridgeId,
          phase: 'prepared',
          destinationRuntimeId: identity.destinationRuntimeId
        }),
        surfaceBinding: null
      }
    ])
    expect(createStore().load(identity)).toMatchObject({ phase: 'prepared' })
  })

  it('fails closed when a recovery record is stored under another bridge filename', () => {
    const store = createStore()
    store.prepare(identity, 0)
    const recordFile = readdirSync(directory).find((name) => name.endsWith('.json'))
    const wrongFile = `${createHash('sha256').update('another-bridge').digest('hex')}.json`
    renameSync(join(directory, recordFile!), join(directory, wrongFile))

    expect(() => createStore().listRecoveryCandidates()).toThrow(
      'pty_ownership_transfer_destination_store_invalid'
    )
  })
})
