import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as durable from '../../durable-file-write'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { parseOutputOutboxRecord } from './pty-ownership-transfer-destination-output-outbox-record'
import { identity } from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

const model = {
  modelData: 'old history\r\nvisible',
  cols: 80,
  rows: 24,
  restoreMetadata: { version: 1 as const, pendingEscapeTailAnsi: '\x1b[' }
}
const initial = { ...model, version: 1, identity, throughSeq: 1, modelSequenceEnd: 100 }
const cleared = { ...model, modelData: 'visible' }
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-model-clear-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
const reopen = () => new PtyOwnershipTransferDestinationOutputOutbox({ directory })
function setup() {
  const outbox = reopen()
  outbox.open(identity, 1)
  outbox.recordInitialModelSnapshot(identity, initial)
  return outbox
}
const clearRequest = () => ({
  operationId: 'clear-1',
  expectedRevision: 0,
  throughSeq: 1,
  modelSequenceEnd: 100,
  model: cleared
})
function append(outbox: PtyOwnershipTransferDestinationOutputOutbox) {
  outbox.enqueue(identity, { seq: 2, data: 'next' })
  outbox.recordModelSnapshot(identity, {
    ...model,
    modelData: 'visible next',
    checkpoint: {
      ptyId: identity.terminalId,
      frameSeq: 2,
      fragmentStartSu: 0,
      fragmentEndSu: 4,
      frameLengthSu: 4,
      data: 'next',
      modelSequenceEnd: 104
    }
  })
  outbox.acknowledge(identity, 2)
}

it('persists clear at the imported baseline without rewriting the capture or ACK cursors', () => {
  const outbox = setup()
  const before = outbox.load(identity)
  outbox.recordModelClear(identity, clearRequest())
  expect(reopen().load(identity)).toEqual(before)
  expect(reopen().loadInitialModelSnapshot(identity)).toEqual(initial)
  expect(reopen().loadModelSnapshot(identity)).toBeNull()
  expect(reopen().loadRestorableModel(identity)).toEqual({ ...initial, ...cleared })
  expect(reopen().loadModelClear(identity)).toEqual({
    operationIds: ['clear-1'],
    throughSeq: 1,
    modelSequenceEnd: 100,
    model: cleared
  })
})

it('preserves clear retry receipts through later output and subsequent clears', () => {
  const outbox = setup()
  outbox.recordModelClear(identity, clearRequest())
  append(outbox)
  const before = outbox.load(identity)
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  reopen().recordModelClear(identity, clearRequest())
  expect(write).not.toHaveBeenCalled()
  expect(reopen().loadModelSnapshot(identity)?.modelData).toBe('visible next')
  expect(reopen().loadRestorableModel(identity)?.modelData).toBe('visible next')
  outbox.recordModelClear(identity, {
    ...clearRequest(),
    operationId: 'clear-2',
    expectedRevision: 1,
    throughSeq: 2,
    modelSequenceEnd: 104,
    model: { ...cleared, modelData: 'next' }
  })
  expect(reopen().load(identity)).toEqual(before)
  expect(reopen().loadModelClear(identity)).toMatchObject({
    operationIds: ['clear-1', 'clear-2'],
    throughSeq: 2,
    modelSequenceEnd: 104,
    model: { modelData: 'next' }
  })
  expect(reopen().loadInitialModelSnapshot(identity)).toEqual(initial)
})

it.each(['before', 'after'])('recovers an uncertain %s-write clear atomically', (boundary) => {
  const outbox = setup()
  const write = durable.writeFileDurableSync
  vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
    if (boundary === 'after') {
      write(...args)
    }
    throw new Error('disk failure')
  })
  expect(() => outbox.recordModelClear(identity, clearRequest())).toThrow('disk failure')
  expect(reopen().loadModelClear(identity)?.model ?? null).toEqual(
    boundary === 'after' ? cleared : null
  )
  expect(reopen().loadInitialModelSnapshot(identity)).toEqual(initial)
  reopen().recordModelClear(identity, clearRequest())
  expect(reopen().loadModelClear(identity)?.model).toEqual(cleared)
})

it.each(['cursor', 'revision', 'sequence'])(
  'refuses a changed %s boundary without writes',
  (mode) => {
    const outbox = setup()
    const request = clearRequest()
    if (mode === 'cursor') {
      request.throughSeq = 2
    }
    if (mode === 'revision') {
      request.expectedRevision = 1
    }
    if (mode === 'sequence') {
      request.modelSequenceEnd = 101
    }
    const write = vi.spyOn(durable, 'writeFileDurableSync')
    expect(() => outbox.recordModelClear(identity, request)).toThrow('boundary_changed')
    expect(write).not.toHaveBeenCalled()
  }
)

it('retains newly queued output while committing clear at the still-acknowledged model boundary', () => {
  const outbox = setup()
  outbox.enqueue(identity, { seq: 2, data: 'next' })
  const before = outbox.load(identity)
  outbox.recordModelClear(identity, clearRequest())
  expect(reopen().load(identity)).toEqual(before)
  expect(reopen().loadRestorableModel(identity)?.modelData).toBe('visible')
})

it('fences concurrent clears and does not expose mutable persisted payloads', () => {
  const outbox = setup()
  outbox.recordModelClear(identity, clearRequest())
  expect(() =>
    outbox.recordModelClear(identity, { ...clearRequest(), operationId: 'other' })
  ).toThrow('boundary_changed')
  const saved = outbox.loadModelClear(identity)!
  saved.operationIds.push('invented')
  saved.model.modelData = 'invented'
  expect(reopen().loadModelClear(identity)?.model).toEqual(cleared)
  expect(reopen().loadModelClear(identity)?.operationIds).toEqual(['clear-1'])
})

function serializedRecord() {
  return structuredClone({
    version: 5,
    identity,
    baseEndSeq: 1,
    acknowledgedEndSeq: 1,
    frames: [],
    modelCheckpoints: [],
    initialModelSnapshot: initial,
    modelClear: { operationIds: ['clear-1'], throughSeq: 1, modelSequenceEnd: 100, model: cleared }
  })
}
const parse = (value: unknown) =>
  parseOutputOutboxRecord(value, identity, { maxBytes: 10000, maxFrames: 100 })

it.each(['old-version', 'missing', 'duplicate', 'ahead', 'metadata', 'capacity'])(
  'rejects malformed clear storage: %s',
  (mode) => {
    const record = serializedRecord()
    if (mode === 'old-version') {
      record.version = 4
    }
    if (mode === 'missing') {
      delete (record as Partial<typeof record>).modelClear
    }
    if (mode === 'duplicate') {
      record.modelClear.operationIds.push('clear-1')
    }
    if (mode === 'ahead') {
      record.modelClear.modelSequenceEnd++
    }
    if (mode === 'metadata') {
      delete (record.modelClear.model as Partial<typeof model>).restoreMetadata
    }
    if (mode === 'capacity') {
      record.modelClear.operationIds = Array.from({ length: 4097 }, (_, i) => `clear-${i}`)
    }
    expect(() => parse(record)).toThrow()
  }
)

it('retains v4 readability and requires an explicit v5 marker for clear semantics', () => {
  const record = serializedRecord()
  expect(parse(record).version).toBe(5)
  expect(parse({ ...record, version: 4, modelClear: undefined }).version).toBe(4)
})
