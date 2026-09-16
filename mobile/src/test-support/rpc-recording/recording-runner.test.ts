import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { operationModuleLoader } from './operation-module-loader'
import { describe, expect, it } from 'vitest'
import { captureArguments, captureError, captureValue } from './recording-values'
import { RECORDER_DIRECTORY, recorderSha256 } from './recorder-digest'
import { RECORDING_DRIVERS } from './recording-drivers'
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
import { driveReplyMatrix, replyMatrixGoldenId, replyMatrixSites } from './reply-matrix'
import {
  REPLY_MATRIX_NORMAL_RESULT_INVENTORY,
  replyMatrixNormalResult
} from './reply-matrix-normal-result'
import { runRecording } from './run-recording'
import { valueHash, type InternedObservation } from './golden-value-pool'
import type { Observation, RecordingScenario } from './recording-scenario'
import type { RecordedValue } from './recording-values'

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

  it('stores a growing history once per entry and still resolves every checkpoint', () => {
    const golden = sampleGolden('pooled')
    golden.recording.checkpoints = [
      { id: 'first', observation: history(['a']) },
      { id: 'second', observation: history(['a', 'b']) },
      { id: 'third', observation: history(['a', 'b', 'c']) }
    ]
    const file = goldenFile(golden)
    // Six observations of three distinct entries: each is stored once, plus the three states.
    expect(Object.keys(file.values)).toHaveLength(6)
    expect(file.recording.checkpoints.map((checkpoint) => checkpoint.observation.sender)).toEqual([
      ['a'].map(entryHash),
      ['a', 'b'].map(entryHash),
      ['a', 'b', 'c'].map(entryHash)
    ])
    // Whichever checkpoint an entry was first seen in, every later reference resolves to it.
    const directory = mkdtempSync(join(tmpdir(), 'rpc-recording-'))
    try {
      writeFileSync(join(directory, 'pooled.json'), goldenBytes(golden))
      expect(readGolden(directory, 'pooled')).toEqual(golden)
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('refuses a pooled entry edited in place, and one no checkpoint reads', () => {
    const golden = sampleGolden('tampered')
    golden.recording.checkpoints = [{ id: 'first', observation: history(['a']) }]
    const file = goldenFile(golden)
    const hash = entryHash('a')
    const directory = mkdtempSync(join(tmpdir(), 'rpc-recording-'))
    try {
      writeFileSync(
        join(directory, 'tampered.json'),
        JSON.stringify({
          ...file,
          values: { ...file.values, [hash]: { name: 'a', hostile: true } }
        })
      )
      expect(() => readGolden(directory, 'tampered')).toThrow(
        `Golden value ${hash} does not hash to its pool key`
      )
      writeFileSync(
        join(directory, 'orphaned.json'),
        JSON.stringify({
          ...file,
          values: { ...file.values, [valueHash('unread')]: 'unread' }
        })
      )
      expect(() => readGolden(directory, 'orphaned')).toThrow(
        `Golden pool holds unreferenced values: ${valueHash('unread')}`
      )
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('interns a field by its declared container, not by the value it happens to hold', () => {
    const golden = sampleGolden('shape')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of the test is a field recorded with the wrong container.
    golden.recording.checkpoints[0]!.observation.sender = {} as unknown as RecordedValue[]
    expect(() => goldenBytes(golden)).toThrow(
      'Observation field settled.sender is declared a list but recorded object'
    )
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

  // A matrix that cannot drive a family has to fail. The prefix list it replaced returned no site
  // and the loop skipped, which is how ten families lost their matrix without a red test.
  it('refuses a family it cannot matrix instead of skipping it', () => {
    const base: RecordingScenario = {
      id: 'family',
      operation: 'op',
      version: 1,
      family: 'op',
      sites: [],
      schedules: [],
      steps: [{ action: 'mount', id: 'mount' }, { checkpoint: 'settled' }]
    }
    expect(() => replyMatrixSites(base)).toThrow('No scripted reply to drive a matrix over')
    expect(() =>
      replyMatrixSites({
        ...base,
        steps: [
          { complete: 'a#1', params: {}, reply: { ok: true, result: 1 } },
          { complete: 'a#1', params: {}, reply: { ok: true, result: 2 } },
          { checkpoint: 'settled' }
        ]
      })
    ).toThrow('Matrix sites must be unique')
    expect(replyMatrixGoldenId('hostedReview.eligibility', 'hostedReview.create#1')).toBe(
      'matrix-hostedreview.eligibility-hostedreview.create-1'
    )
  })

  it('refuses a matrix site with no recorded success, and a redundant inventory entry', () => {
    const scenario = (reply: unknown): RecordingScenario => ({
      id: 'family',
      operation: 'op',
      version: 1,
      family: 'op',
      sites: [],
      schedules: [],
      steps: [{ complete: 'a#1', params: {}, reply }, { checkpoint: 'settled' }]
    })
    // Absent and null are partitions of their own, so neither can stand in as the success control.
    for (const reply of [{ ok: true }, { ok: true, result: null }, { ok: false }]) {
      expect(() => replyMatrixNormalResult('op', [scenario(reply)], 'a#1')).toThrow(
        'No fulfilled reply recorded for matrix site'
      )
    }
    expect(
      replyMatrixNormalResult('op', [scenario({ ok: true, result: { n: 1 } })], 'a#1')
    ).toEqual({
      n: 1
    })
    const inventoried = REPLY_MATRIX_NORMAL_RESULT_INVENTORY[0]!
    expect(() =>
      replyMatrixNormalResult(
        inventoried.family,
        [
          {
            ...scenario({ ok: true, result: { n: 1 } }),
            steps: [
              { complete: inventoried.request, params: {}, reply: { ok: true, result: { n: 1 } } },
              { checkpoint: 'settled' }
            ]
          }
        ],
        inventoried.request
      )
    ).toThrow('drop its REPLY_MATRIX_NORMAL_RESULT_INVENTORY entry')
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
      writeFileSync(join(directory, 'runner.ts'), 'export const runner = 1')
      const original = recorderSha256(root)
      writeFileSync(join(directory, 'README.md'), 'prose')
      // Each call spells the root differently: `recorderSha256` caches per root string, so reusing
      // one would assert nothing.
      expect(recorderSha256(`${root}/`)).toBe(original)
      writeFileSync(join(directory, 'runner.ts'), 'export const runner = 2')
      expect(recorderSha256(`${root}//`)).not.toBe(original)
    } finally {
      rmSync(root, { recursive: true })
    }
  })

  // A suite that only reads goldens cannot put an observation in one, so it is not provenance; the
  // drivers are, because a golden's bytes come from them.
  it('digests the recording drivers and no other suite', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-drivers-'))
    try {
      const directory = join(root, RECORDER_DIRECTORY)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'runner.ts'), 'export const runner = 1')
      const original = recorderSha256(root)
      writeFileSync(join(directory, 'reads-goldens.test.ts'), 'export const suite = 1')
      expect(recorderSha256(`${root}/`)).toBe(original)
      writeFileSync(join(directory, RECORDING_DRIVERS[0]), 'export const suite = 1')
      expect(recorderSha256(`${root}//`)).not.toBe(original)
    } finally {
      rmSync(root, { recursive: true })
    }
  })

  it('keeps every named driver real and unimported by the engine', () => {
    const directory = resolve(import.meta.dirname)
    const missing = RECORDING_DRIVERS.filter((driver) => !existsSync(join(directory, driver)))
    const imported = readdirSync(directory)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /(?:from|import\()\s*'\.[^']*\.test'/.test(readFileSync(join(directory, file), 'utf8'))
      )
    expect({ missing, imported }).toEqual({ missing: [], imported: [] })
  })

  it('delivers each frame through the session that published its subscribe', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    const events: unknown[] = []
    try {
      const dispose = transport.client.subscribe(CLIENT_EVENTS, null, (result) =>
        events.push(result)
      )
      // Cut over before the stream is ready. The retiring registry keeps the cancelled subscribe
      // precisely so it can unsubscribe once the id arrives, which is the behaviour a transport
      // that routed every frame through the current session would drop on the floor.
      await transport.cutover()
      await clock.flush()
      transport.frame(`${CLIENT_EVENTS}#1`, null, readyFrame('sub-1'))
      transport.frame(`${CLIENT_EVENTS}#2`, null, readyFrame('sub-2'))
      dispose()
      expect(
        transport.payloads.map((payload) => [payload.name, JSON.parse(payload.json).id])
      ).toEqual([
        [`${CLIENT_EVENTS}#1`, 'frame-1'],
        [`${CLIENT_EVENTS}#2`, 'frame-2'],
        ['runtime.clientEvents.unsubscribe#1', 'frame-3'],
        ['runtime.clientEvents.unsubscribe#2', 'frame-4']
      ])
      expect(transport.payloads.map((payload) => JSON.parse(payload.json).params)).toEqual([
        null,
        null,
        { subscriptionId: 'sub-1' },
        { subscriptionId: 'sub-2' }
      ])
      // Only the live generation reaches the listener; the retiring one is fenced by the client.
      expect(events).toEqual([readyFrame('sub-2').result])
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('routes a whole host response at a stream id, and asserts the subscribe params', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    const events: unknown[] = []
    const changed = { ok: true, streaming: true, result: { type: 'worktreesChanged' } }
    try {
      const dispose = transport.client.subscribe(CLIENT_EVENTS, null, (result) =>
        events.push(result)
      )
      transport.frame(`${CLIENT_EVENTS}#1`, null, readyFrame('sub-1'))
      transport.frame(`${CLIENT_EVENTS}#1`, null, changed)
      expect(() => transport.frame(`${CLIENT_EVENTS}#1`, { asserted: 1 }, changed)).toThrow(
        'Subscribe params mismatch'
      )
      expect(() => transport.frame(`${CLIENT_EVENTS}#2`, null, changed)).toThrow(
        'Missing subscription payload'
      )
      // The host's own end of stream, in the two responses it really sends: the `end` event as a
      // streaming frame, then the unary reply the dispatcher sends once the handler returns. The
      // second is what closes the stream here, and the registry reports it to the listener as an
      // error — so the disposer below has no subscription left and publishes no unsubscribe.
      transport.frame(`${CLIENT_EVENTS}#1`, null, {
        ok: true,
        streaming: true,
        result: { type: 'end' }
      })
      transport.frame(`${CLIENT_EVENTS}#1`, null, { ok: true })
      expect(() =>
        transport.frame(`${CLIENT_EVENTS}#1`, null, {
          ok: false,
          error: { code: 'refused', message: 'gone' }
        })
      ).toThrow('No open stream for frame')
      dispose()
      expect(transport.payloads.map((payload) => payload.name)).toEqual([`${CLIENT_EVENTS}#1`])
      expect(events).toEqual([
        readyFrame('sub-1').result,
        changed.result,
        { type: 'end' },
        { type: 'error', message: 'Streaming request ended before it was ready.', error: undefined }
      ])
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('stamps each payload with the request count, which is all a reordered subscribe moves', async () => {
    const subscribeFirst = await payloadsFrom((client) => {
      client.subscribe(CLIENT_EVENTS, null, () => {})
      void client.sendRequest('worktree.show', {}).catch(() => {})
    })
    const sendFirst = await payloadsFrom((client) => {
      void client.sendRequest('worktree.show', {}).catch(() => {})
      client.subscribe(CLIENT_EVENTS, null, () => {})
    })
    // The published order is identical either way, because a subscribe publishes synchronously
    // while a request first waits for connected. Without `sent` the swap moves no recorded byte.
    expect(sendFirst.map((payload) => payload.name)).toEqual(
      subscribeFirst.map((payload) => payload.name)
    )
    expect(subscribeFirst.map((payload) => payload.sent)).toEqual([0, 1])
    expect(sendFirst.map((payload) => payload.sent)).toEqual([1, 1])
  })

  it('drives the reply matrix over frames, and matrixes a family that only subscribes', () => {
    const changed = { ok: true, streaming: true, result: { type: 'worktreesChanged' } }
    const base: RecordingScenario = {
      id: 'stream',
      operation: 'op',
      version: 1,
      family: 'op',
      sites: [],
      schedules: [],
      steps: [
        { action: 'mount', id: 'mount' },
        { frame: `${CLIENT_EVENTS}#1`, params: null, reply: readyFrame('sub-1') },
        { checkpoint: 'ready' },
        { frame: `${CLIENT_EVENTS}#1`, params: null, reply: changed },
        { checkpoint: 'changed' }
      ]
    }
    // While the matrix read only completions this family threw its own named failure instead.
    expect(replyMatrixSites(base)).toEqual([`${CLIENT_EVENTS}#1@1`, `${CLIENT_EVENTS}#1@2`])
    expect(replyMatrixGoldenId('op', `${CLIENT_EVENTS}#1@2`)).toBe(
      'matrix-op-runtime.clientevents.subscribe-1-2'
    )
    expect(replyMatrixNormalResult('op', [base], `${CLIENT_EVENTS}#1@2`)).toEqual(changed.result)
    const variants = driveReplyMatrix(base, `${CLIENT_EVENTS}#1@1`, readyFrame('sub-1').result)
    const partitions = variants.map((variant) => variant.id.replace('stream.', ''))
    // Nine of eleven: a frame holds no promise, so neither transport rejection applies to one.
    expect(partitions).toEqual([
      'normal',
      'result-absent',
      'result-null',
      'inner-ok-missing',
      'inner-false-string-error',
      'inner-false-object-error',
      'outer-refused',
      'outer-refused-no-message',
      'method-not-found'
    ])
    const replies = new Map(variants.map((variant) => [variant.id, variant.steps[1]]))
    // The success shapes keep the flag that routes them to the stream; a refusal never had one.
    expect(replies.get('stream.normal')).toEqual(base.steps[1])
    expect(replies.get('stream.result-absent')).toEqual({
      frame: `${CLIENT_EVENTS}#1`,
      params: null,
      reply: { ok: true, streaming: true }
    })
    expect(replies.get('stream.outer-refused')).toMatchObject({
      reply: { ok: false, error: { code: 'refused' } }
    })
    // No `optional` on a downstream frame: the registry routes a streaming response to the id that
    // opened the stream whatever the divergence did, so every scripted frame still lands.
    expect(variants[0]!.steps[3]).toEqual(base.steps[3])
  })

  it('refuses a mutation anchor that matches more than once', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-mutant-'))
    try {
      const anchor =
        "const overrides = settings == null ? undefined : settingsField(settings, 'prBotAuthorOverrides')"
      mkdirSync(join(root, 'mod'), { recursive: true })
      writeFileSync(
        join(root, 'mod/settings-read-operations.ts'),
        `const raw = {} as { settings?: unknown }\nconst settings = raw.settings\nexport function first() {\n  ${anchor}\n  return overrides\n}\nexport function second() {\n  ${anchor}\n  return overrides\n}\n`
      )
      // Its own spec, not one borrowed from the mutant table: the guard is the loader's, and the
      // table is not an input to anything the loader does while recording.
      const loader = operationModuleLoader(root, {
        name: 'repeated-anchor',
        file: 'settings-read-operations.ts',
        before: anchor,
        after: 'const overrides = undefined'
      })
      expect(() => loader.load('mod/settings-read-operations.ts')).toThrow(
        'matched 2 sites, expected 1'
      )
    } finally {
      rmSync(root, { recursive: true })
    }
  })
})

const CLIENT_EVENTS = 'runtime.clientEvents.subscribe'

function readyFrame(subscriptionId: string) {
  return { ok: true, streaming: true, result: { type: 'ready', subscriptionId } }
}

/** The payloads one scripted client publishes, with the transport torn down either way. */
async function payloadsFrom(
  drive: (client: ScriptedRpcTransport['client']) => void
): Promise<ScriptedRpcTransport['payloads']> {
  const clock = vitestRecordingScheduler()
  clock.start()
  const transport = new ScriptedRpcTransport(clock.elapsed)
  try {
    drive(transport.client)
    await clock.flush()
    return [...transport.payloads]
  } finally {
    transport.dispose()
    await clock.flush()
    clock.stop()
  }
}

function entryHash(name: string): string {
  return valueHash({ name })
}

/** An append-only sender history, the shape every checkpoint after the first re-states. */
function history(names: readonly string[]): Observation {
  return {
    ...observation(names.join('-')),
    sender: names.map((name) => ({ name })),
    settlements: Object.fromEntries(names.map((name) => [name, { name }]))
  }
}

function goldenFile(golden: GoldenRecording): {
  values: Record<string, unknown>
  recording: { checkpoints: { id: string; observation: InternedObservation }[] }
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bytes were just produced by goldenBytes, so the pool and interned checkpoints are present.
  return JSON.parse(goldenBytes(golden)) as {
    values: Record<string, unknown>
    recording: { checkpoints: { id: string; observation: InternedObservation }[] }
  }
}

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
    scenarioSha256: 'd'.repeat(64),
    platform: process.platform,
    scenarioVersion: 1,
    projectionVersion: PROJECTION_VERSION,
    goldenFormatVersion: GOLDEN_FORMAT_VERSION,
    recording: { scenario: id, checkpoints: [{ id: 'settled', observation: observation('idle') }] }
  }
}
