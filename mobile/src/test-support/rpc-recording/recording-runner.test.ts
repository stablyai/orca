import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operationModuleLoader } from './operation-module-loader'
import { describe, expect, it } from 'vitest'
import { captureArguments, captureError, captureValue } from './recording-values'
import { RECORDER_DIRECTORY, recorderSha256 } from './recorder-digest'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import {
  compareGolden,
  GOLDEN_FORMAT_VERSION,
  goldenBytes,
  PROJECTION_VERSION,
  readGolden,
  writeGolden,
  type GoldenRecording
} from './golden-recording'
import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import { runRecording } from './run-recording'
import type { Observation, RecordingScenario } from './recording-scenario'

describe('recording boundaries', () => {
  it('preserves omitted arguments, explicit undefined, null, order, and tagged-looking objects', () => {
    expect(captureArguments(['m'])).not.toEqual(captureArguments(['m', undefined]))
    expect(captureArguments(['m', undefined])).not.toEqual(captureArguments(['m', null]))
    expect(captureValue({ b: undefined, a: null })).toEqual(captureValue({ a: null, b: undefined }))
    expect(captureValue({ $rpc: 'undefined' })).not.toEqual(captureValue(undefined))
    expect(captureValue([1, 2])).not.toEqual(captureValue([2, 1]))
  })

  it('runs the actual stable-client projection and physical serialization', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    try {
      const result = transport.client.sendRequest(
        'worktree.ps',
        { omitted: undefined, nullable: null },
        { timeoutMs: 7 }
      )
      await clock.flush()
      expect(transport.requests[0].args).toEqual(
        captureArguments(['worktree.ps', { omitted: undefined, nullable: null }, { timeoutMs: 7 }])
      )
      expect(JSON.parse(transport.payloads[0].json)).toEqual({
        id: 'frame-1',
        deviceToken: 'recording-device',
        method: 'worktree.ps',
        params: { nullable: null, supportsWorktreeVisibilitySourceDefaults: true }
      })
      transport.complete(
        'worktree.ps#1',
        { omitted: undefined, nullable: null, supportsWorktreeVisibilitySourceDefaults: true },
        { ok: true, result: null }
      )
      await result
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('requires logical bindings plus matching params for concurrent same-method calls', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    try {
      const left = transport.client.sendRequest('files.list', { worktree: 'A' })
      const right = transport.client.sendRequest('files.list', { worktree: 'B' })
      await clock.flush()
      expect(() => transport.complete('files.list#1', { worktree: 'A' }, {})).toThrow(
        'logical binding'
      )
      expect(() => transport.bind('left', 'files.list#1', { worktree: 'B' })).toThrow(
        'params mismatch'
      )
      transport.bind('left', 'files.list#1', { worktree: 'A' })
      transport.bind('right', 'files.list#2', { worktree: 'B' })
      transport.complete('right', { worktree: 'B' }, { ok: true, result: [] })
      transport.complete('left', { worktree: 'A' }, { ok: true, result: [] })
      await Promise.all([left, right])
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('records actual deadline ambiguity and leaves peers pending before their deadlines', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    try {
      void transport.client.sendRequest('short', {}, { timeoutMs: 5 }).catch(() => {})
      void transport.client.sendRequest('long', {}, { timeoutMs: 50 }).catch(() => {})
      await clock.advance(5)
      // Exact virtual milliseconds: the deadline is recorded at the value the product asked for.
      expect(transport.requests[0].settlement).toEqual({
        status: 'rejected',
        startedAt: 0,
        settledAt: 5,
        error: {
          category: 'Error',
          message: 'Request timed out: short',
          isRpcDeliveryUnknown: true
        }
      })
      expect(transport.requests[1].settlement).toEqual({ status: 'pending', startedAt: 0 })
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('never writes from candidate mode and requires both recording authorizations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rpc-recording-'))
    const golden = sampleGolden('test')
    const previous = process.env.RPC_FOUNDATION_RECORD
    try {
      process.env.RPC_FOUNDATION_RECORD = '0'
      await expect(writeGolden(directory, golden, '--record')).rejects.toThrow('require')
      process.env.RPC_FOUNDATION_RECORD = '1'
      await expect(writeGolden(directory, golden, 'candidate')).rejects.toThrow('require')
      await writeGolden(directory, golden, '--record')
      expect(readGolden(directory, 'test')).toEqual(golden)
      expect(() => readGolden(directory, '../escape')).toThrow('Unsafe')
      writeFileSync(
        join(directory, 'stale.json'),
        JSON.stringify({
          ...JSON.parse(readFileSync(join(directory, 'test.json'), 'utf8')),
          goldenFormatVersion: 1
        })
      )
      expect(() => readGolden(directory, 'stale')).toThrow(
        `format version 1; this reader requires ${GOLDEN_FORMAT_VERSION}`
      )
    } finally {
      if (previous === undefined) {
        delete process.env.RPC_FOUNDATION_RECORD
      } else {
        process.env.RPC_FOUNDATION_RECORD = previous
      }
      rmSync(directory, { recursive: true })
    }
  })

  it('pools repeated observation values and still resolves them for comparison', () => {
    const golden = sampleGolden('pooled')
    golden.recording.checkpoints.push({ id: 'again', observation: observation('idle') })
    const file = JSON.parse(goldenBytes(golden)) as {
      values: Record<string, unknown>
      recording: { checkpoints: { observation: Observation }[] }
    }
    const [first, second] = file.recording.checkpoints
    expect(second!.observation).toEqual(first!.observation)
    // [] is shared by three fields; {} and the state object are the other two pool entries.
    expect(Object.keys(file.values)).toHaveLength(3)
    expect(file.values[first!.observation.state as unknown as string]).toEqual({ phase: 'idle' })
  })

  it('names the scenario, checkpoint and field, and prints values rather than hashes', () => {
    const expected = sampleGolden('diffable')
    const actual = sampleGolden('diffable')
    actual.recording.checkpoints[0]!.observation.state = { phase: 'busy' }
    expect(() => compareGolden(expected, actual)).toThrow(
      /Recording differs: diffable checkpoint settled field state\.phase[\s\S]*"idle"[\s\S]*"busy"/
    )
  })

  it('accepts a dependency bump but still refuses a different baseline', () => {
    const expected = sampleGolden('provenance')
    const bumped = sampleGolden('provenance')
    bumped.lockfileSha256 = 'd'.repeat(64)
    expect(() => compareGolden(expected, bumped)).not.toThrow()
    const rebased = sampleGolden('provenance')
    rebased.baseline = 'e'.repeat(40)
    expect(() => compareGolden(expected, rebased)).toThrow(
      /Recording differs: provenance header baseline/
    )
  })

  it('records a shared prefix once and refuses a variant that already diverged', () => {
    const base: RecordingScenario = {
      id: 'family',
      operation: 'op',
      version: 1,
      family: 'op',
      sites: [],
      schedules: [],
      steps: [
        { action: 'mount', id: 'mount' },
        { checkpoint: 'pending' },
        { complete: 'a#1', params: {}, reply: { ok: true } },
        { checkpoint: 'settled' }
      ]
    }
    const variant = (id: string, reply: unknown): RecordingScenario => ({
      ...base,
      id,
      steps: base.steps.map((step) => ('complete' in step ? { ...step, reply } : step))
    })
    const hoisted = hoistPreludeCheckpoints(base, [
      { divergence: 2, scenario: variant('family.ok', { ok: true }) },
      { divergence: 2, scenario: variant('family.refused', { ok: false }) }
    ])
    expect(hoisted.map((scenario) => scenario.id)).toEqual([
      'family.prelude',
      'family.ok',
      'family.refused'
    ])
    expect(hoisted[0]!.steps.filter((step) => 'checkpoint' in step)).toEqual([
      { checkpoint: 'pending' }
    ])
    expect(hoisted[1]!.steps.filter((step) => 'checkpoint' in step)).toEqual([
      { checkpoint: 'settled' }
    ])
    expect(() =>
      hoistPreludeCheckpoints(base, [
        { divergence: 3, scenario: variant('family.late', { ok: false }) }
      ])
    ).toThrow('diverges from the base')
  })

  it('refuses a checkpoint whose clock drifted from the scripted advances', async () => {
    const scheduler = vitestRecordingScheduler()
    await expect(
      runRecording(
        {
          id: 'drift',
          operation: 'op',
          version: 1,
          family: 'op',
          sites: [],
          schedules: [],
          steps: [{ advance: 10 }, { checkpoint: 'settled' }]
        },
        () => ({ action: () => {}, state: () => ({}), dispose: () => {} }),
        { ...scheduler, elapsed: () => scheduler.elapsed() + 1 }
      )
    ).rejects.toThrow('Checkpoint clock drifted: drift settled at 11, scripted 10')
  })

  it('records an error code and cause, and omits both when the error carries neither', () => {
    expect(captureError(new Error('plain'))).toEqual({
      category: 'Error',
      message: 'plain',
      isRpcDeliveryUnknown: false
    })
    const detailed = Object.assign(new TypeError('outer'), {
      code: 'refused',
      cause: new Error('inner')
    })
    expect(captureError(detailed)).toMatchObject({
      code: 'refused',
      cause: { category: 'Error', message: 'inner' }
    })
  })

  it('digests every executable recorder input and ignores prose', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-recorder-'))
    try {
      const directory = join(root, RECORDER_DIRECTORY)
      mkdirSync(directory, { recursive: true })
      mkdirSync(join(root, 'mobile/rpc-foundation'), { recursive: true })
      writeFileSync(join(root, 'mobile/rpc-foundation/pilot-scenarios.json'), '{}')
      writeFileSync(join(directory, 'runner.ts'), 'export const runner = 1')
      const original = recorderSha256(root)
      writeFileSync(join(directory, 'README.md'), 'prose')
      expect(recorderSha256(join(root, '.'))).toBe(original)
      writeFileSync(join(directory, 'runner.ts'), 'export const runner = 2')
      expect(recorderSha256(join(root, './'))).not.toBe(original)
    } finally {
      rmSync(root, { recursive: true })
    }
  })

  it('refuses a mutation anchor that matches more than once', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-mutant-'))
    try {
      const anchor = 'const overrides = result?.settings?.prBotAuthorOverrides'
      mkdirSync(join(root, 'mod'), { recursive: true })
      writeFileSync(
        join(root, 'mod/use-pr-bot-author-overrides.ts'),
        `const result = {} as { settings?: { prBotAuthorOverrides?: unknown } }\nexport function first() {\n  ${anchor}\n  return overrides\n}\nexport function second() {\n  ${anchor}\n  return overrides\n}\n`
      )
      const loader = operationModuleLoader(root, 'bot-overrides-envelope')
      expect(() => loader.load('mod/use-pr-bot-author-overrides.ts')).toThrow(
        'matched 2 sites, expected 1'
      )
    } finally {
      rmSync(root, { recursive: true })
    }
  })
})

function observation(phase: string): Observation {
  return {
    sender: [],
    payloads: [],
    settlements: {},
    state: { phase },
    effects: []
  }
}

function sampleGolden(id: string): GoldenRecording {
  return {
    operation: 'op',
    family: 'op',
    namedDeltas: [],
    runnerVersion: 1,
    baseline: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64),
    recorderSha256: 'c'.repeat(64),
    platform: process.platform,
    scenarioVersion: 1,
    projectionVersion: PROJECTION_VERSION,
    goldenFormatVersion: GOLDEN_FORMAT_VERSION,
    recording: { scenario: id, checkpoints: [{ id: 'settled', observation: observation('idle') }] }
  }
}
