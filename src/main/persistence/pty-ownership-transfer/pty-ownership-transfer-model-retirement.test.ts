import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as durable from '../../durable-file-write'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { parseOutputOutboxRecord } from './pty-ownership-transfer-destination-output-outbox-record'
import {
  identity,
  preparation
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-model-retirement-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
const reopen = () => new PtyOwnershipTransferDestinationOutputOutbox({ directory })
const model = {
  version: 1,
  identity,
  throughSeq: 0,
  modelSequenceEnd: 100,
  modelData: 'retained final history',
  cols: 80,
  rows: 24,
  restoreMetadata: { version: 1 as const }
}
const event = {
  identity,
  surfaceBinding: preparation.surfacePublication.surfaceBinding,
  destinationClaim: { generation: 1, claimId: 'exit-owner' },
  finalOutputSeq: 0,
  exit: { verdict: 'exited', code: 17, eventId: 'exit-1', observedAt: '2026-09-06T00:00:00Z' }
}
function setup(withModel = true) {
  const outbox = reopen()
  outbox.open(identity, 0)
  if (withModel) {
    outbox.recordInitialModelSnapshot(identity, model)
  }
  return outbox
}

it.each([false, true])(
  'retains final evidence and output through prepared/applied retirement, model=%s',
  (withModel) => {
    const outbox = setup(withModel)
    const before = outbox.load(identity)
    outbox.recordRetirement(identity, { phase: 'prepared', event })
    expect(reopen().loadRetirement(identity)).toEqual({ phase: 'prepared', event })
    expect(reopen().load(identity)).toEqual(before)
    outbox.recordRetirement(identity, { phase: 'applied', event })
    expect(reopen().loadRetirement(identity)).toEqual({ phase: 'applied', event })
    expect(reopen().loadRestorableModel(identity)).toEqual(withModel ? model : null)
    const write = vi.spyOn(durable, 'writeFileDurableSync')
    outbox.recordRetirement(identity, { phase: 'prepared', event })
    outbox.recordRetirement(identity, { phase: 'applied', event })
    expect(write).not.toHaveBeenCalled()
  }
)

it.each(['prepared', 'applied'])(
  'recovers before/after-write uncertainty in %s transition',
  (phase) => {
    for (const after of [false, true]) {
      const target = { ...identity, bridgeId: `${identity.bridgeId}-${phase}-${after}` }
      const evidence = { ...event, identity: target }
      const outbox = reopen()
      outbox.open(target, 0)
      if (phase === 'applied') {
        outbox.recordRetirement(target, { phase: 'prepared', event: evidence })
      }
      const write = durable.writeFileDurableSync
      const fault = vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
        if (after) {
          write(...args)
        }
        throw new Error('uncertain retirement')
      })
      expect(() => outbox.recordRetirement(target, { phase, event: evidence })).toThrow(
        'uncertain retirement'
      )
      fault.mockRestore()
      expect(reopen().loadRetirement(target)?.phase ?? null).toBe(
        after ? phase : phase === 'applied' ? 'prepared' : null
      )
      reopen().recordRetirement(target, { phase, event: evidence })
      expect(reopen().loadRetirement(target)?.phase).toBe(phase)
    }
  }
)

it('refuses unapplied or changed exit evidence without writes', () => {
  const outbox = setup()
  expect(() => outbox.recordRetirement(identity, { phase: 'applied', event })).toThrow(
    'not_prepared'
  )
  outbox.recordRetirement(identity, { phase: 'prepared', event })
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  expect(() =>
    outbox.recordRetirement(identity, {
      phase: 'applied',
      event: {
        ...event,
        exit: { ...event.exit, code: 0 }
      }
    })
  ).toThrow('retirement_conflict')
  expect(write).not.toHaveBeenCalled()
})

it('blocks new output, baseline movement, model writes and clears after retirement', () => {
  const outbox = setup(false)
  outbox.recordRetirement(identity, { phase: 'prepared', event })
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  expect(() => outbox.enqueue(identity, { seq: 1, data: 'late' })).toThrow('model_retired')
  expect(() => outbox.stage(identity, { seq: 2, data: 'late' })).toThrow('model_retired')
  expect(() => outbox.markCommittedThrough(identity, 1)).toThrow('model_retired')
  expect(() => outbox.recordInitialModelSnapshot(identity, model)).toThrow('model_retired')
  expect(() => outbox.recordModelSnapshot(identity, {} as never)).toThrow('model_retired')
  expect(() => outbox.recordModelCheckpoint(identity, {} as never)).toThrow('model_retired')
  expect(() => outbox.recordModelClear(identity, {} as never)).toThrow('model_retired')
  expect(write).not.toHaveBeenCalled()
})

it('retains prior clear and capture bytes alongside retirement', () => {
  const outbox = setup()
  outbox.recordModelClear(identity, {
    operationId: 'clear',
    expectedRevision: 0,
    throughSeq: 0,
    modelSequenceEnd: 100,
    model: { ...model, modelData: '' }
  })
  outbox.recordRetirement(identity, { phase: 'prepared', event })
  expect(reopen().loadInitialModelSnapshot(identity)).toEqual(model)
  expect(reopen().loadRestorableModel(identity)?.modelData).toBe('')
  expect(reopen().loadModelClear(identity)?.operationIds).toEqual(['clear'])
})

it('refuses retirement while final output remains pending', () => {
  const outbox = setup()
  outbox.enqueue(identity, { seq: 1, data: 'final' })
  expect(() => outbox.recordRetirement(identity, { phase: 'prepared', event })).toThrow(
    'boundary_invalid'
  )
  expect(outbox.load(identity)?.pendingFrames).toEqual([{ seq: 1, data: 'final' }])
})

it('retires an acknowledged final frame and still deduplicates source replay without changing evidence', () => {
  const outbox = setup()
  const frame = { seq: 1, data: 'last' }
  outbox.enqueue(identity, frame)
  const snapshot = {
    ...model,
    modelData: 'retained final history last',
    checkpoint: {
      ptyId: identity.terminalId,
      frameSeq: 1,
      fragmentStartSu: 0,
      fragmentEndSu: 4,
      frameLengthSu: 4,
      data: 'last',
      modelSequenceEnd: 104
    }
  }
  outbox.recordModelSnapshot(identity, snapshot)
  outbox.acknowledge(identity, 1)
  const finalEvent = { ...event, finalOutputSeq: 1 }
  outbox.recordRetirement(identity, { phase: 'prepared', event: finalEvent })
  outbox.recordRetirement(identity, { phase: 'applied', event: finalEvent })
  expect(reopen().loadRetirement(identity)?.event.finalOutputSeq).toBe(1)
  expect(reopen().loadRestorableModel(identity)?.modelData).toBe(snapshot.modelData)
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  expect(reopen().enqueue(identity, frame)).toBe('acknowledged')
  expect(reopen().acknowledge(identity, 1).acknowledgedEndSeq).toBe(1)
  expect(write).not.toHaveBeenCalled()
  const copy = reopen().loadRetirement(identity)!
  copy.event.exit = { ...copy.event.exit, code: 99 }
  expect(reopen().loadRetirement(identity)?.event.exit.code).toBe(17)
})

it.each(['version', 'missing', 'identity', 'host', 'cursor', 'claim', 'live'])(
  'rejects malformed retirement storage: %s',
  (mode) => {
    const value = structuredClone({
      version: 6,
      identity,
      baseEndSeq: 0,
      acknowledgedEndSeq: 0,
      frames: [],
      modelCheckpoints: [],
      retirement: { phase: 'prepared', event }
    })
    if (mode === 'version') {
      value.version = 1
    }
    if (mode === 'missing') {
      delete (value as Partial<typeof value>).retirement
    }
    if (mode === 'identity') {
      value.retirement.event.identity.incarnationId = 'other'
    }
    if (mode === 'host') {
      Object.assign(value.retirement.event.surfaceBinding, { executionHostId: 'ssh:host' })
    }
    if (mode === 'cursor') {
      value.retirement.event.finalOutputSeq = 1
    }
    if (mode === 'claim') {
      value.retirement.event.destinationClaim.generation = 0
    }
    if (mode === 'live') {
      value.retirement.event.exit.verdict = 'live'
    }
    expect(() =>
      parseOutputOutboxRecord(value, identity, { maxBytes: 1000, maxFrames: 10 })
    ).toThrow()
  }
)
