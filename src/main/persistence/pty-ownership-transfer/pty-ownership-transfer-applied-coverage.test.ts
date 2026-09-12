import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import {
  identity,
  preparation
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-applied-coverage-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})
const reopen = () => new PtyOwnershipTransferDestinationOutputOutbox({ directory })
const model = {
  modelData: 'baseline',
  cols: 80,
  rows: 24,
  restoreMetadata: { version: 1 as const }
}
function setup() {
  const outbox = reopen()
  outbox.open(identity, 0)
  outbox.recordInitialModelSnapshot(identity, {
    ...model,
    version: 1,
    identity,
    throughSeq: 0,
    modelSequenceEnd: 100
  })
  return outbox
}
function append(outbox: PtyOwnershipTransferDestinationOutputOutbox, partial = false) {
  outbox.enqueue(identity, { seq: 1, data: 'next' })
  outbox.recordModelSnapshot(identity, {
    ...model,
    modelData: partial ? 'baseline ne' : 'baseline next',
    checkpoint: {
      ptyId: identity.terminalId,
      frameSeq: 1,
      fragmentStartSu: 0,
      fragmentEndSu: partial ? 2 : 4,
      frameLengthSu: 4,
      data: partial ? 'ne' : 'next',
      modelSequenceEnd: partial ? 102 : 104
    }
  })
}

it('recognizes initial durable model coverage after reopening the disk record', () => {
  setup()
  expect(reopen().inspectAppliedCoverage(identity, 0)).toEqual({
    throughSeq: 0,
    acknowledgedEndSeq: 0,
    modelThroughSeq: 0,
    modelSequenceEnd: 100
  })
})

it('does not infer application from queued output', () => {
  const outbox = setup()
  outbox.enqueue(identity, { seq: 1, data: 'queued' })
  expect(() => reopen().inspectAppliedCoverage(identity, 1)).toThrow('coverage_unconfirmed')
})

it('does not infer acknowledgment from a durable model ahead of the sink cursor', () => {
  const outbox = setup()
  append(outbox)
  expect(() => reopen().inspectAppliedCoverage(identity, 1)).toThrow('coverage_unconfirmed')
  outbox.acknowledge(identity, 1)
  expect(reopen().inspectAppliedCoverage(identity, 1)).toEqual({
    throughSeq: 1,
    acknowledgedEndSeq: 1,
    modelThroughSeq: 1,
    modelSequenceEnd: 104
  })
})

it('reports only complete frames when the restorable model contains a partial next frame', () => {
  const outbox = setup()
  append(outbox, true)
  expect(reopen().inspectAppliedCoverage(identity, 0)).toMatchObject({
    modelThroughSeq: 0,
    modelSequenceEnd: 102
  })
  expect(() => reopen().inspectAppliedCoverage(identity, 1)).toThrow('coverage_unconfirmed')
})

it('does not infer coverage from ACK alone without restorable model bytes', () => {
  const outbox = reopen()
  outbox.open(identity, 0)
  outbox.enqueue(identity, { seq: 1, data: 'data' })
  outbox.acknowledge(identity, 1)
  expect(() => outbox.inspectAppliedCoverage(identity, 1)).toThrow('coverage_model_required')
})

it('requires restore metadata even when model bytes exist', () => {
  const outbox = reopen()
  outbox.open(identity, 0)
  outbox.enqueue(identity, { seq: 1, data: 'legacy' })
  outbox.recordModelSnapshot(identity, {
    checkpoint: {
      ptyId: identity.terminalId,
      frameSeq: 1,
      fragmentStartSu: 0,
      fragmentEndSu: 6,
      frameLengthSu: 6,
      data: 'legacy',
      modelSequenceEnd: 6
    },
    modelData: 'legacy',
    cols: 80,
    rows: 24
  })
  outbox.acknowledge(identity, 1)
  expect(() => outbox.inspectAppliedCoverage(identity, 1)).toThrow('coverage_model_required')
})

it('does not treat a model checkpoint without saved model bytes as applied coverage', () => {
  const outbox = reopen()
  outbox.open(identity, 0)
  outbox.enqueue(identity, { seq: 1, data: 'next' })
  outbox.recordModelCheckpoint(identity, {
    ptyId: identity.terminalId,
    frameSeq: 1,
    fragmentStartSu: 0,
    fragmentEndSu: 4,
    frameLengthSu: 4,
    data: 'next',
    modelSequenceEnd: 4
  })
  expect(() => reopen().inspectAppliedCoverage(identity, 0)).toThrow('coverage_model_required')
})

it('preserves coverage after a durable model clear without rewriting output cursors', () => {
  const outbox = setup()
  outbox.recordModelClear(identity, {
    operationId: 'clear',
    expectedRevision: 0,
    throughSeq: 0,
    modelSequenceEnd: 100,
    model: { ...model, modelData: '' }
  })
  expect(reopen().loadRestorableModel(identity)?.modelData).toBe('')
  expect(reopen().inspectAppliedCoverage(identity, 0)).toMatchObject({
    modelThroughSeq: 0,
    modelSequenceEnd: 100
  })
})

it.each(['prepared', 'applied'] as const)(
  'refuses %s retirement despite preserved model bytes',
  (phase) => {
    const outbox = setup()
    const event = {
      identity,
      surfaceBinding: preparation.surfacePublication.surfaceBinding,
      destinationClaim: { generation: 1, claimId: 'claim' },
      finalOutputSeq: 0,
      exit: { verdict: 'exited', code: 0, eventId: 'exit', observedAt: '2026-09-06T00:00:00Z' }
    }
    outbox.recordRetirement(identity, { phase: 'prepared', event })
    if (phase === 'applied') {
      outbox.recordRetirement(identity, { phase, event })
    }
    expect(() => reopen().inspectAppliedCoverage(identity, 0)).toThrow('retired')
  }
)

it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid requested sequence %s',
  (throughSeq) => {
    expect(() => setup().inspectAppliedCoverage(identity, throughSeq)).toThrow()
  }
)
