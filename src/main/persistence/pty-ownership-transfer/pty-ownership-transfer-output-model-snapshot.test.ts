import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as durable from '../../durable-file-write'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { parseOutputOutboxRecord } from './pty-ownership-transfer-destination-output-outbox-record'
import { identity } from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

const snapshot = {
  checkpoint: {
    ptyId: identity.terminalId,
    frameSeq: 1,
    fragmentStartSu: 0,
    fragmentEndSu: 3,
    frameLengthSu: 3,
    data: 'one',
    modelSequenceEnd: 3
  },
  modelData: 'baseline\r\none',
  cols: 80,
  rows: 24
}
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-model-snapshot-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function setup() {
  const outbox = new PtyOwnershipTransferDestinationOutputOutbox({ directory })
  outbox.open(identity, 0)
  outbox.enqueue(identity, { seq: 1, data: 'one' })
  outbox.enqueue(identity, { seq: 2, data: 'two' })
  return outbox
}
const reopen = () => new PtyOwnershipTransferDestinationOutputOutbox({ directory })
const record = () =>
  JSON.parse(
    readFileSync(
      join(
        directory,
        readdirSync(directory).find((name) => name.endsWith('.json'))!
      ),
      'utf8'
    )
  )

it('persists exact model bytes and applied cursor together across restart and ACK pruning', () => {
  const outbox = setup()
  outbox.recordModelSnapshot(identity, snapshot)
  expect(record().version).toBe(2)
  expect(reopen().loadModelSnapshot(identity)).toEqual(snapshot)
  expect(reopen().loadModelCheckpoints(identity)).toEqual([snapshot.checkpoint])
  outbox.acknowledge(identity, 1)
  expect(reopen().loadModelCheckpoints(identity)).toEqual([])
  expect(reopen().loadModelSnapshot(identity)).toEqual(snapshot)
  expect(reopen().load(identity)?.pendingFrames).toEqual([{ seq: 2, data: 'two' }])
  const next = {
    ...snapshot,
    modelData: 'baseline\r\nonetwo',
    checkpoint: {
      ...snapshot.checkpoint,
      frameSeq: 2,
      data: 'two',
      modelSequenceEnd: 6
    }
  }
  outbox.recordModelSnapshot(identity, next)
  outbox.acknowledge(identity, 2)
  expect(reopen().loadModelSnapshot(identity)).toEqual(next)
})

it.each(['before', 'after'])(
  'an uncertain %s-write failure recovers a whole snapshot/cursor pair',
  (boundary) => {
    const outbox = setup()
    const write = durable.writeFileDurableSync
    vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
      if (boundary === 'after') {
        write(...args)
      }
      throw new Error('disk failure')
    })
    expect(() => outbox.recordModelSnapshot(identity, snapshot)).toThrow('disk failure')
    expect(reopen().loadModelSnapshot(identity)).toEqual(boundary === 'after' ? snapshot : null)
    expect(reopen().loadModelCheckpoints(identity)).toEqual(
      boundary === 'after' ? [snapshot.checkpoint] : []
    )
    reopen().recordModelSnapshot(identity, snapshot)
    expect(reopen().loadModelSnapshot(identity)).toEqual(snapshot)
  }
)

it('retries exact snapshots without writes and returns defensive copies', () => {
  const outbox = setup()
  outbox.recordModelSnapshot(identity, snapshot)
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  outbox.recordModelSnapshot(identity, structuredClone(snapshot))
  expect(write).not.toHaveBeenCalled()
  const copy = outbox.loadModelSnapshot(identity)!
  copy.modelData = 'changed'
  copy.checkpoint.data = 'bad'
  expect(outbox.loadModelSnapshot(identity)).toEqual(snapshot)
})

it('refuses ACKs past the durable model snapshot and cursor-only checkpoint advancement', () => {
  const outbox = setup()
  outbox.recordModelSnapshot(identity, snapshot)
  expect(() => outbox.acknowledge(identity, 2)).toThrow('snapshot_ack_ahead')
  expect(() =>
    outbox.recordModelCheckpoint(identity, { ...snapshot.checkpoint, frameSeq: 2, data: 'two' })
  ).toThrow('snapshot_required')
  expect(outbox.load(identity)?.acknowledgedEndSeq).toBe(0)
})

it('supports contiguous frame fragments but refuses partial-frame ACKs and skipped fragments', () => {
  const outbox = setup()
  const first = {
    ...snapshot,
    checkpoint: { ...snapshot.checkpoint, fragmentEndSu: 1, data: 'o', modelSequenceEnd: 1 }
  }
  outbox.recordModelSnapshot(identity, first)
  expect(() => outbox.acknowledge(identity, 1)).toThrow('snapshot_ack_ahead')
  expect(() => outbox.recordModelSnapshot(identity, snapshot)).toThrow('snapshot_gap')
  const second = {
    ...snapshot,
    checkpoint: { ...snapshot.checkpoint, fragmentStartSu: 1, data: 'ne' }
  }
  outbox.recordModelSnapshot(identity, second)
  outbox.acknowledge(identity, 1)
  expect(reopen().loadModelSnapshot(identity)).toEqual(second)
})

it.each([
  { cols: 0 },
  { rows: 10_001 },
  { modelData: '' },
  { checkpoint: { ...snapshot.checkpoint, data: 'bad' } },
  { checkpoint: { ...snapshot.checkpoint, frameSeq: 2, data: 'two' } }
])('rejects invalid snapshots before persistence: %j', (patch) => {
  const outbox = setup()
  expect(() => outbox.recordModelSnapshot(identity, { ...snapshot, ...patch })).toThrow()
  expect(outbox.loadModelSnapshot(identity)).toBeNull()
  expect(record().version).toBe(1)
})

it('refuses changed data at the same cursor and regressing model sequences', () => {
  const outbox = setup()
  outbox.recordModelSnapshot(identity, snapshot)
  expect(() =>
    outbox.recordModelSnapshot(identity, { ...snapshot, modelData: 'conflict' })
  ).toThrow('snapshot_conflict')
  expect(() =>
    outbox.recordModelSnapshot(identity, {
      ...snapshot,
      checkpoint: {
        ...snapshot.checkpoint,
        frameSeq: 2,
        data: 'two'
      }
    })
  ).toThrow('snapshot_conflict')
  expect(reopen().loadModelSnapshot(identity)).toEqual(snapshot)
})

it.each(['downgrade', 'missing', 'cursor', 'fragment', 'ack'])(
  'rejects malformed on-disk snapshot evidence: %s',
  (mode) => {
    setup().recordModelSnapshot(identity, snapshot)
    const value = record()
    if (mode === 'downgrade') {
      value.version = 1
    }
    if (mode === 'missing') {
      delete value.modelSnapshot
    }
    if (mode === 'cursor') {
      value.modelSnapshot.checkpoint.frameSeq = 3
    }
    if (mode === 'fragment') {
      value.modelSnapshot.checkpoint.data = 'bad'
    }
    if (mode === 'ack') {
      value.acknowledgedEndSeq = 2
      value.frames = []
    }
    expect(() =>
      parseOutputOutboxRecord(value, identity, { maxBytes: 4 * 1024 * 1024, maxFrames: 65536 })
    ).toThrow()
  }
)

it('refuses a snapshot older than previously journaled model fragments', () => {
  const outbox = setup()
  outbox.recordModelCheckpoint(identity, {
    ...snapshot.checkpoint,
    frameSeq: 2,
    data: 'two',
    modelSequenceEnd: 6
  })
  expect(() => outbox.recordModelSnapshot(identity, snapshot)).toThrow('snapshot_conflict')
  expect(outbox.loadModelSnapshot(identity)).toBeNull()
})

it('preserves restore metadata across ACK and refuses format or snapshot downgrades', () => {
  const outbox = setup()
  const model = {
    ...snapshot,
    restoreMetadata: {
      version: 1 as const,
      kittyKeyboardFlags: 5,
      cwd: null,
      pendingEscapeTailAnsi: '\x1b['
    }
  }
  outbox.recordModelSnapshot(identity, model)
  expect(record().version).toBe(3)
  outbox.acknowledge(identity, 1)
  expect(reopen().loadModelSnapshot(identity)).toEqual(model)
  const downgraded = record()
  downgraded.version = 2
  expect(() =>
    parseOutputOutboxRecord(downgraded, identity, { maxBytes: 4 * 1024 * 1024, maxFrames: 65536 })
  ).toThrow('version_invalid')
  expect(() =>
    outbox.recordModelSnapshot(identity, {
      ...snapshot,
      checkpoint: {
        ...snapshot.checkpoint,
        frameSeq: 2,
        data: 'two',
        modelSequenceEnd: 6
      }
    })
  ).toThrow('metadata_required')
  expect(reopen().loadModelSnapshot(identity)).toEqual(model)
})
