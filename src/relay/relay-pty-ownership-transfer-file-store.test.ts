import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferCommitRequest,
  type PtyOwnershipTransferPrepareRequest
} from '../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'
import {
  RelayPtyOwnershipTransferAdapter,
  type RelayPtyOwnershipTransferAdapterOptions,
  type RelayPtyOwnershipTransferSource
} from './relay-pty-ownership-transfer-adapter'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'

const source: RelayPtyOwnershipTransferSource = {
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 4
}

const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: source.terminalId
}

const identity: PtyOwnershipTransferPrepareRequest = {
  version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  bridgeId: 'bridge-1',
  ...source,
  destinationRuntimeId: 'bun-runtime-1',
  surfacePublication: { version: 1, surfaceBinding }
}

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-relay-transfer-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function createAdapter(options: Partial<RelayPtyOwnershipTransferAdapterOptions> = {}) {
  const writes: string[] = []
  const publishedFrames: { seq: number; data: string }[] = []
  const setInputFenced = vi.fn()
  const adapter = new RelayPtyOwnershipTransferAdapter({
    store: new RelayPtyOwnershipTransferFileStore(directory),
    resolveSource: () => source,
    authorizeRequest: () => true,
    setInputFenced,
    writeDestinationInput: (_terminalId, data) => writes.push(data),
    publishDestinationOutput: (_identity, _attachmentId, frame) => {
      if (frame) {
        publishedFrames.push(frame)
      }
    },
    applyDestinationControl: () => 'applied',
    publishDestinationExit: vi.fn(),
    ...options
  })
  return { adapter, writes, publishedFrames, setInputFenced }
}

function commitRequest(acceptedSourceEndSeq: number): PtyOwnershipTransferCommitRequest {
  return {
    ...identity,
    acceptedSourceEndSeq,
    receipt: {
      receiptId: 'commit-1',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq,
      committedAt: '2026-08-31T00:00:00.000Z'
    }
  }
}

function publishRequest(acceptedSourceEndSeq: number) {
  return {
    ...identity,
    publicationReceipt: {
      version: 1 as const,
      publicationReceiptId: 'publication-1',
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      commitReceipt: commitRequest(acceptedSourceEndSeq).receipt,
      publishedAt: '2026-08-31T00:00:01.000Z',
      surfaceBinding
    }
  }
}

describe('relay PTY ownership-transfer durable file store', () => {
  it('reconstructs retained history, receipts, fences, and input dedupe after restart', () => {
    const first = createAdapter()
    first.adapter.observeOutput(source.terminalId, 'before')
    first.adapter.prepare(identity)
    first.adapter.observeOutput(source.terminalId, 'during')
    first.adapter.replay({ ...identity, afterSeq: 0 })
    first.adapter.commit(commitRequest(2))
    first.adapter.attach({ ...identity, attachmentId: 'attachment-1' })
    first.adapter.acceptInput({ ...identity, inputId: 'input-1', data: 'ls\n' })
    first.adapter.publish(publishRequest(2))

    const restored = createAdapter()
    expect(restored.setInputFenced).toHaveBeenCalledOnce()
    expect(restored.setInputFenced).toHaveBeenCalledWith(source.terminalId, true)
    expect(restored.adapter.snapshot(identity.bridgeId)).toMatchObject({
      phase: 'published',
      sourceOutputEndSeq: 2,
      replayStartSeq: 1,
      acceptedInputIds: 1,
      commitReceipt: { receiptId: 'commit-1' },
      publicationReceipt: { publicationReceiptId: 'publication-1' }
    })
    expect(restored.adapter.acceptInput({ ...identity, inputId: 'input-1', data: 'ls\n' })).toEqual(
      { accepted: false, duplicate: true }
    )
    expect(restored.writes).toEqual([])

    restored.adapter.rekeyReconnect({
      ...identity,
      previousReconnectGeneration: 4,
      reconnectGeneration: 5,
      attachmentId: 'attachment-2'
    })
    restored.adapter.observeOutput(source.terminalId, 'after')
    expect(restored.publishedFrames).toEqual([{ seq: 3, data: 'after' }])
  })

  it('reconstructs and reports authoritative exit evidence after restart', () => {
    const first = createAdapter({
      createExitEventId: () => 'exit-before-restart',
      now: () => new Date('2026-08-31T00:00:02.000Z')
    })
    first.adapter.prepare(identity)
    first.adapter.commit(commitRequest(0))
    first.adapter.observeExit(source.terminalId, source.incarnationId, 17)

    const restored = createAdapter()
    const exit = {
      verdict: 'exited',
      eventId: 'exit-before-restart',
      observedAt: '2026-08-31T00:00:02.000Z',
      code: 17
    }
    expect(restored.adapter.snapshot(identity.bridgeId)).toMatchObject({ exit })
    expect(restored.adapter.status(identity)).toMatchObject({ phase: 'committed', exit })
  })

  it('fails closed on invalid persisted exit evidence', () => {
    const first = createAdapter()
    first.adapter.prepare(identity)
    first.adapter.commit(commitRequest(0))
    first.adapter.observeExit(source.terminalId, source.incarnationId, 0)
    const recordPath = join(directory, readdirSync(directory)[0]!)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    record.exit = {
      verdict: 'exited',
      eventId: 'bridge-1:exit',
      observedAt: 'not-a-date',
      code: 0
    }
    writeFileSync(recordPath, JSON.stringify(record))

    expect(() => createAdapter()).toThrow('pty_ownership_transfer_relay_journal_invalid')
  })

  it('enforces the record byte cap when a file grows after fstat', () => {
    const first = createAdapter()
    first.adapter.prepare(identity)
    const recordPath = join(directory, readdirSync(directory)[0]!)
    const store = new RelayPtyOwnershipTransferFileStore(directory, {
      closeSync,
      fstatSync: (_descriptor) => {
        const stats = statSync(recordPath)
        // Append through the opened inode after the size check to exercise the
        // bounded descriptor read rather than a path-level stat/read race.
        // Whitespace keeps the JSON valid, so an unbounded path read would
        // incorrectly accept the oversized record instead of failing closed.
        writeFileSync(recordPath, ' '.repeat(8 * 1024 * 1024), { flag: 'a' })
        return stats
      },
      openSync,
      readSync
    })

    expect(() => store.loadAll()).toThrow('pty_ownership_transfer_relay_store_invalid')
  })

  it.each([
    ['prepared', (adapter: RelayPtyOwnershipTransferAdapter) => adapter.prepare(identity)],
    [
      'committed',
      (adapter: RelayPtyOwnershipTransferAdapter) => {
        adapter.prepare(identity)
        adapter.commit(commitRequest(0))
      }
    ],
    [
      'aborted',
      (adapter: RelayPtyOwnershipTransferAdapter) => {
        adapter.prepare(identity)
        adapter.abort(identity)
      }
    ]
  ] as const)('reconstructs the %s phase exactly', (phase, arrange) => {
    arrange(createAdapter().adapter)

    const restored = createAdapter()
    expect(restored.adapter.snapshot(identity.bridgeId)).toMatchObject({ phase })
    expect(restored.setInputFenced).toHaveBeenCalledTimes(phase === 'aborted' ? 0 : 1)
  })

  it('fails closed on a cursor/history conflict without applying a fence', () => {
    const first = createAdapter()
    first.adapter.prepare(identity)
    first.adapter.observeOutput(source.terminalId, 'output')
    const recordPath = join(directory, readdirSync(directory)[0]!)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    record.sourceOutputEndSeq = 42
    writeFileSync(recordPath, JSON.stringify(record))
    const setInputFenced = vi.fn()

    expect(() => createAdapter({ setInputFenced })).toThrow(
      'pty_ownership_transfer_relay_journal_invalid'
    )
    expect(setInputFenced).not.toHaveBeenCalled()
  })

  it('requires a fresh attachment token after relay restart and rejects the old generation', async () => {
    const first = createAdapter()
    first.adapter.prepare(identity)
    first.adapter.commit(commitRequest(0))
    first.adapter.attach({ ...identity, attachmentId: 'attachment-generation-1' })

    const restored = createAdapter()
    expect(
      restored.adapter.rekeyReconnect({
        ...identity,
        previousReconnectGeneration: 4,
        reconnectGeneration: 5,
        attachmentId: 'attachment-generation-2'
      })
    ).toMatchObject({
      attachmentId: 'attachment-generation-2',
      executionVerdict: 'live'
    })
    await expect(
      restored.adapter.control({
        ...identity,
        attachmentId: 'attachment-generation-1',
        controlId: 'control-stale',
        control: { kind: 'resize', cols: 100, rows: 30 }
      })
    ).rejects.toMatchObject({ reason: 'stale-attachment' })
    await expect(
      restored.adapter.control({
        ...identity,
        attachmentId: 'attachment-generation-2',
        controlId: 'control-current',
        control: { kind: 'resize', cols: 100, rows: 30 }
      })
    ).resolves.toMatchObject({ outcome: 'applied' })
  })

  it('restores the durable route generation and rejects a stale rekey after restart', () => {
    const first = createAdapter()
    first.adapter.prepare(identity)
    first.adapter.commit(commitRequest(0))
    first.adapter.attach({ ...identity, attachmentId: 'attachment-4' })
    first.adapter.rekeyReconnect({
      ...identity,
      previousReconnectGeneration: 4,
      reconnectGeneration: 5,
      attachmentId: 'attachment-5'
    })

    const restored = createAdapter().adapter
    expect(restored.status(identity)).toMatchObject({ reconnectGeneration: 5 })
    expect(() =>
      restored.rekeyReconnect({
        ...identity,
        previousReconnectGeneration: 4,
        reconnectGeneration: 6,
        attachmentId: 'attachment-stale'
      })
    ).toThrow(expect.objectContaining({ reason: 'stale-reconnect-generation' }))
    expect(
      restored.rekeyReconnect({
        ...identity,
        previousReconnectGeneration: 5,
        reconnectGeneration: 6,
        attachmentId: 'attachment-6'
      })
    ).toMatchObject({ reconnectGeneration: 6, attachmentId: 'attachment-6' })
  })

  it('reuses a failed emission sequence after relay restart', () => {
    const firstPublicationAttempts: { seq: number; data: string }[] = []
    const first = createAdapter({
      publishDestinationOutput: (_identity, _attachmentId, frame) => {
        firstPublicationAttempts.push(frame)
        throw new Error('destination unavailable')
      }
    })
    first.adapter.prepare(identity)
    first.adapter.commit(commitRequest(0))
    first.adapter.attach({ ...identity, attachmentId: 'attachment-generation-1' })

    expect(() => first.adapter.observeOutput(source.terminalId, 'output', 'emission-1')).toThrow(
      'destination unavailable'
    )
    expect(firstPublicationAttempts).toEqual([{ seq: 1, data: 'output' }])

    const restored = createAdapter()
    restored.adapter.rekeyReconnect({
      ...identity,
      previousReconnectGeneration: 4,
      reconnectGeneration: 5,
      attachmentId: 'attachment-generation-2'
    })
    expect(restored.adapter.observeOutput(source.terminalId, 'output', 'emission-1')).toEqual([
      expect.objectContaining({ ownershipTransfer: expect.objectContaining({ frameSeq: 1 }) })
    ])
    expect(restored.publishedFrames).toEqual([{ seq: 1, data: 'output' }])
    expect(restored.adapter.snapshot(identity.bridgeId)).toMatchObject({ sourceOutputEndSeq: 1 })
  })

  it('retains an ambiguous input reservation across restart instead of replaying the write', () => {
    const writes = vi.fn(() => {
      throw new Error('pty write outcome unknown')
    })
    const first = createAdapter({ writeDestinationInput: writes })
    first.adapter.prepare(identity)
    first.adapter.commit(commitRequest(0))

    expect(() =>
      first.adapter.acceptInput({ ...identity, inputId: 'ambiguous-input', data: 'deploy\n' })
    ).toThrow('pty write outcome unknown')
    expect(first.adapter.snapshot(identity.bridgeId)).toMatchObject({ acceptedInputIds: 1 })

    const restoredWrites = vi.fn()
    const restored = createAdapter({ writeDestinationInput: restoredWrites })
    expect(
      restored.adapter.acceptInput({
        ...identity,
        inputId: 'ambiguous-input',
        data: 'deploy\n'
      })
    ).toEqual({ accepted: false, duplicate: true })
    expect(writes).toHaveBeenCalledOnce()
    expect(restoredWrites).not.toHaveBeenCalled()
  })

  it('keeps the source fenced and retryable when a durable abort fails', () => {
    const saved: unknown[] = []
    let fail = false
    const setInputFenced = vi.fn()
    const adapter = new RelayPtyOwnershipTransferAdapter({
      store: {
        loadAll: () => [],
        save: (record) => {
          if (fail) {
            throw new Error('disk-full')
          }
          saved.push(record)
        },
        remove: () => undefined
      },
      resolveSource: () => source,
      authorizeRequest: () => true,
      setInputFenced,
      writeDestinationInput: () => undefined,
      publishDestinationOutput: () => undefined,
      applyDestinationControl: () => 'applied',
      publishDestinationExit: () => undefined
    })
    adapter.prepare(identity)
    fail = true

    expect(() => adapter.abort(identity)).toThrow('disk-full')
    expect(adapter.snapshot(identity.bridgeId)).toMatchObject({ phase: 'prepared' })
    expect(setInputFenced.mock.calls).toEqual([[source.terminalId, true]])
    expect(saved).toHaveLength(1)
  })
})
