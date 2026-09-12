import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as durable from '../../durable-file-write'
import { identity } from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { parseOutputOutboxRecord } from './pty-ownership-transfer-destination-output-outbox-record'

const seed = {
  version: 1,
  identity,
  throughSeq: 20,
  modelSequenceEnd: 100,
  modelData: 'initial model',
  cols: 80,
  rows: 24,
  restoreMetadata: {
    version: 1 as const,
    kittyKeyboardFlags: 0,
    cwd: null,
    pendingEscapeTailAnsi: ''
  }
}
const next = {
  modelData: 'initial model!',
  cols: 80,
  rows: 24,
  restoreMetadata: seed.restoreMetadata,
  checkpoint: {
    ptyId: identity.terminalId,
    frameSeq: 21,
    fragmentStartSu: 0,
    fragmentEndSu: 1,
    frameLengthSu: 1,
    data: '!',
    modelSequenceEnd: 101
  }
}
let directory: string
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
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-initial-model-'))
  reopen().open(identity, 20)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it('reopens an exact baseline snapshot, with idempotent retries and defensive reads', () => {
  reopen().recordInitialModelSnapshot(identity, seed)
  expect(record().version).toBe(4)
  expect(reopen().loadInitialModelSnapshot(identity)).toEqual(seed)
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  reopen().recordInitialModelSnapshot(identity, structuredClone(seed))
  expect(write).not.toHaveBeenCalled()
  const copy = reopen().loadInitialModelSnapshot(identity)!
  copy.modelData = 'changed'
  expect(reopen().loadInitialModelSnapshot(identity)).toEqual(seed)
  expect(() => reopen().recordInitialModelSnapshot(identity, copy)).toThrow('snapshot_conflict')
})

it.each([
  { throughSeq: 19 },
  { identity: { ...identity, ownerLease: 'other' } },
  { restoreMetadata: undefined },
  { modelSequenceEnd: -1 },
  { cols: 0 }
])('refuses invalid seed evidence: %j', (patch) => {
  expect(() => reopen().recordInitialModelSnapshot(identity, { ...seed, ...patch })).toThrow()
  expect(reopen().loadInitialModelSnapshot(identity)).toBeNull()
})

it('never treats the seed as proof of newly applied output', () => {
  const outbox = reopen()
  outbox.recordInitialModelSnapshot(identity, seed)
  expect(() => outbox.markCommittedThrough(identity, 21)).toThrow('baseline_conflict')
  outbox.enqueue(identity, { seq: 21, data: '!' })
  expect(() => outbox.acknowledge(identity, 21)).toThrow('snapshot_ack_ahead')
  expect(() => outbox.recordModelCheckpoint(identity, next.checkpoint)).toThrow('snapshot_required')
  expect(() =>
    outbox.recordModelSnapshot(identity, { ...next, restoreMetadata: undefined })
  ).toThrow('metadata_required')
  expect(() =>
    outbox.recordModelSnapshot(identity, {
      ...next,
      checkpoint: { ...next.checkpoint, modelSequenceEnd: 100 }
    })
  ).toThrow('snapshot_conflict')
  outbox.recordModelSnapshot(identity, next)
  outbox.acknowledge(identity, 21)
  expect(record().version).toBe(4)
  expect(reopen().loadInitialModelSnapshot(identity)).toEqual(seed)
  expect(reopen().loadModelSnapshot(identity)).toEqual(next)
  expect(reopen().load(identity)?.pendingFrames).toEqual([])
})

it.each(['downgrade', 'omission', 'ack', 'checkpoint'])(
  'rejects malformed durable seed records: %s',
  (mode) => {
    reopen().recordInitialModelSnapshot(identity, seed)
    const value = record()
    if (mode === 'downgrade') {
      value.version = 1
    }
    if (mode === 'omission') {
      delete value.initialModelSnapshot
    }
    if (mode === 'ack') {
      value.acknowledgedEndSeq = 21
    }
    if (mode === 'checkpoint') {
      value.modelCheckpoints = [next.checkpoint]
    }
    expect(() =>
      parseOutputOutboxRecord(value, identity, { maxBytes: 4194304, maxFrames: 65536 })
    ).toThrow()
  }
)

it.each(['before', 'after'])(
  'recovers an uncertain %s-write seed failure atomically',
  (boundary) => {
    const write = durable.writeFileDurableSync
    vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
      if (boundary === 'after') {
        write(...args)
      }
      throw new Error('disk failure')
    })
    expect(() => reopen().recordInitialModelSnapshot(identity, seed)).toThrow('disk failure')
    expect(reopen().loadInitialModelSnapshot(identity)).toEqual(boundary === 'after' ? seed : null)
    reopen().recordInitialModelSnapshot(identity, seed)
    expect(reopen().loadInitialModelSnapshot(identity)).toEqual(seed)
  }
)

it('refuses late initialization after cursor-only advancement', () => {
  reopen().markCommittedThrough(identity, 21)
  expect(() => reopen().recordInitialModelSnapshot(identity, seed)).toThrow('too_late')
})
