import { materializeScenario } from './scenario-execution-mode'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../../src/shared/github/work-item-target'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import { BRIDGED_PARITY_FLAG, BRIDGED_PARITY_OFF } from '../bridged-parity/divergence-classes'
import { C5_PAGE_CLOSURE } from '../bridged-parity/c5-page-closure'
import { C6_BROWSER_CLOSURE_FAMILIES } from '../bridged-parity/c6-browser-closure-families'
import { C2_PAGE_CLOSURE } from '../bridged-parity/c2-page-closure'
import { C3_PAGE_CLOSURE } from '../bridged-parity/c3-page-closure'
import {
  pageClosureDrift,
  readPageClosure,
  type PageClosureObservation
} from '../bridged-parity/page-closure'
import { strictReplayVerdict, type BridgedReplay } from '../bridged-parity/replay-verdict'
import { isKeyedObject, withReplyMeta } from '../bridged-parity/divergence-evidence'
import { familyGoldens, pilotGoldens } from './derived-goldens'
import { compareGolden, readGolden } from './golden-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import type { Observation, Recording, RecordingScenario } from './recording-scenario'
import type { AttemptObservation } from './recording-causality'
import { captureArguments, captureValue, type RecordedValue } from './recording-values'
import { readScenarios } from './scenario-input'
import { runRecording } from './run-recording'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')
const observed = new Map<string, PageClosureObservation>()
const corpusChecks: (() => void)[] = []
function afterCorpus(_id: string, check: () => void) {
  corpusChecks.push(check)
}

async function replay(
  id: string,
  scenarios: readonly RecordingScenario[],
  mode: 'native' | 'page-original' | 'page-reply-meta'
): Promise<BridgedReplay> {
  const pairs: BridgePortPair<RpcClient>[] = []
  const checkpoints: Recording['checkpoints'] = []
  try {
    for (const scenario of scenarios) {
      const recording = await runRecording(
        scenario,
        pilotMountAdapters(root, { device: scenario }).adapters[scenario.operation]!,
        vitestRecordingScheduler(),
        mode === 'native'
          ? undefined
          : (rpc, observation) => {
              const pair = createBridgePortPair({
                rpc,
                observation: observation.openBridge(),
                sessionId: 'recording-session',
                buildId: 'recording-build',
                ...(mode === 'page-reply-meta' ? { rewriteToPage: withReplyMeta } : {})
              })
              pairs.push(pair)
              observation.onDispose(() => disposeBridgePortPair(pair))
              for (let round = 0; round < 4; round += 1) {
                pair.drainNow()
              }
              if (pair.client.getShellSession() === null) {
                throw new Error('The actual page did not receive init')
              }
              return pair.client
            }
      )
      checkpoints.push(
        ...recording.checkpoints.map((checkpoint) =>
          scenarios.length > 1
            ? { ...checkpoint, id: `${scenario.id}:${checkpoint.id}` }
            : checkpoint
        )
      )
    }
    return { recording: { scenario: id, checkpoints }, didThrow: false, thrown: null, pairs }
  } catch (thrown) {
    return { recording: null, didThrow: true, thrown, pairs }
  }
}

function rows(value: RecordedValue): Record<string, RecordedValue>[] {
  if (!Array.isArray(value) || !value.every((row) => isKeyedObject(row))) {
    throw new Error('Missing actual recorded rows')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all rows were checked as non-array objects immediately above.
  return value as Record<string, RecordedValue>[]
}
function attempts(observation: Observation): AttemptObservation[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runner clones the transport attempt array at this exact Recording boundary.
  return observation.sender as unknown as AttemptObservation[]
}

// Only known protocol response slots are translated. Result/user objects are never traversed.
function response(
  value: RecordedValue,
  original: RecordedValue,
  ids: ReadonlyMap<string, string>,
  replyMeta: boolean
): RecordedValue {
  if (!isKeyedObject(value) || typeof value.id !== 'string' || typeof value.ok !== 'boolean') {
    return value
  }
  const id = ids.get(value.id)
  if (!id) {
    throw new Error('Reply has no actual physical binding')
  }
  const translated: Record<string, RecordedValue> = { ...value, id }
  if (
    replyMeta &&
    isKeyedObject(original) &&
    !Object.hasOwn(original, '_meta') &&
    Object.hasOwn(translated, '_meta')
  ) {
    expect(translated._meta).toEqual({ runtimeId: 'counterfactual-runtime' })
    delete translated._meta
  }
  return translated
}

function comparison(
  expected: Recording,
  raw: Recording,
  scenarios: readonly RecordingScenario[],
  replyMeta: boolean
): { expected: Recording; actual: Recording } {
  expect(raw.scenario).toBe(expected.scenario)
  expect(raw.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(
    expected.checkpoints.map((checkpoint) => checkpoint.id)
  )
  const project = (before: Observation, after: Observation, checkpoint: string) => {
    const sources =
      scenarios.length === 1
        ? [...scenarios]
        : scenarios.filter(
            (scenario) =>
              scenario.steps.some(
                (step) => 'checkpoint' in step && `${scenario.id}:${step.checkpoint}` === checkpoint
              ) || `${scenario.id}:cleanup` === checkpoint
          )
    if (sources.length !== 1) {
      throw new Error('Missing or crossed checkpoint input occurrence')
    }
    const source = sources[0]!
    const base = input.scenarios.find((candidate) => candidate.id === source.lineage?.baseScenario)
    if (!base) {
      throw new Error('Missing actual base input for probe declarations')
    }
    const declarations = (source.bridgeOperations ?? []).map((operation) => {
      const step =
        source.steps.find(
          (step) => step.bridgeSite && 'complete' in step && step.complete === operation.probeSite
        ) ??
        materializeScenario(base, 'bridge').steps.find(
          (step) => step.bridgeSite && 'complete' in step && step.complete === operation.probeSite
        )
      if (!step) {
        throw new Error('Operation has no source-declared probe')
      }
      return step
    })
    const probeNames = new Set(
      declarations.map((step) => {
        if (!('complete' in step)) {
          throw new Error('Declared probe is not a completion')
        }
        return step.complete
      })
    )
    if (probeNames.size !== declarations.length) {
      throw new Error('Duplicate declared probe')
    }
    const nativePayloads = rows(before.payloads)
    const rawPayloads = rows(after.payloads)
    const names = new Map<string, string>()
    const probeIds = new Set<string>()
    for (const sender of attempts(after)) {
      const posts = sender.bridge?.posts
      if (!posts) {
        throw new Error('Missing actual page invocation')
      }
      if (posts.length === 0) {
        expect(nativePayloads.filter((row) => row.name === sender.name)).toEqual([])
        expect(sender.settlement.status).toBe('rejected')
        expect(sender.bridge!.page!.afterArgs).toEqual(sender.args)
        continue
      }
      if (posts.length !== 1) {
        throw new Error('Duplicate actual page request')
      }
      const post = posts[0]!
      const posted: unknown = JSON.parse(post.json)
      if (
        !isKeyedObject(posted) ||
        posted.type !== 'request' ||
        posted.id !== post.id ||
        post.parent !== sender.name
      ) {
        throw new Error('Crossed actual page request')
      }
      const declared = post.children.filter((child) => probeNames.has(child.name))
      const children = post.children.filter((child) => !probeNames.has(child.name))
      const expectedOperation = sources[0]!.bridgeOperations?.find(
        (entry) => entry.request === sender.name
      )
      expect(declared).toHaveLength(expectedOperation ? 1 : 0)
      if (expectedOperation) {
        expect(post.children.map((child) => child.method)).toEqual(
          expectedOperation.methods.slice(0, post.children.length)
        )
      }
      for (const probe of declared) {
        const declaration = declarations.find(
          (step) => 'complete' in step && step.complete === probe.name
        )
        if (
          !declaration ||
          !('complete' in declaration) ||
          declaration.reject ||
          !probe.frame ||
          probe.method !== 'status.get'
        ) {
          throw new Error('Unexpected bridge-only probe')
        }
        expect(probe.args).toEqual(
          captureArguments([
            'status.get',
            undefined,
            {
              timeoutMs: 30_000,
              ...(isKeyedObject(posted.options) ? posted.options : {}),
              beforeSend: () => {}
            }
          ])
        )
        if (probe.completion) {
          expect(probe.completion.reply).toEqual(captureValue(declaration.reply))
          expect(probe.settlement.status).toBe('fulfilled')
        } else if (checkpoint === 'cleanup' || checkpoint === `${source.id}:cleanup`) {
          expect(probe.settlement).toMatchObject({
            status: 'rejected',
            error: { message: 'Connection closed', isRpcDeliveryUnknown: true }
          })
          expect(sender.settlement).toMatchObject({
            status: 'rejected',
            error: { category: 'BridgeClientClosedError', message: 'the page bridge was closed' }
          })
        } else {
          expect(probe.settlement.status).toBe('pending')
        }
        const payload = rawPayloads.find((row) => row.name === probe.name)
        if (!payload || typeof payload.json !== 'string') {
          throw new Error('Probe has no actual bytes')
        }
        expect(JSON.parse(payload.json)).toEqual({
          id: probe.frame.id,
          deviceToken: 'recording-device',
          method: 'status.get'
        })
        probeIds.add(probe.frame.id)
      }
      if (!children.length && declared.length === 1 && !declared[0]!.completion) {
        continue
      }
      if (children.length !== 1) {
        throw new Error('Actual operation did not forward exactly once')
      }
      const child = children[0]!
      if (
        (child.frame || child.allocation) &&
        (!child.frame || !child.allocation || child.frame.id !== child.allocation.id)
      ) {
        throw new Error('Missing actual operation allocation/frame')
      }
      expect(child.method).toBe(posted.method)
      if (declared.length) {
        expect(declared).toHaveLength(1)
        expect(declared[0]!.completion!.ordinal).toBeLessThan(child.ordinal)
      }
      names.set(child.name, sender.name)
    }
    const kept = rawPayloads.filter((row) => {
      if (typeof row.json !== 'string') {
        throw new Error('Missing raw bytes')
      }
      return !probeIds.has(JSON.parse(row.json).id)
    })
    expect(kept).toHaveLength(nativePayloads.length)
    const ids = new Map<string, string>()
    for (const [index, row] of kept.entries()) {
      const native = nativePayloads[index]!
      if (typeof row.json !== 'string' || typeof native.json !== 'string') {
        throw new Error('Missing request bytes')
      }
      const frame = JSON.parse(row.json),
        original = JSON.parse(native.json)
      expect(names.get(String(row.name)) ?? row.name).toBe(native.name)
      expect({ ...frame, id: original.id }).toEqual(original)
      if (ids.has(frame.id) || [...ids.values()].includes(original.id)) {
        throw new Error('Non-bijective protocol IDs')
      }
      ids.set(frame.id, original.id)
    }
    const sender = attempts(after).map((attempt, index) => {
      const original = attempts(before)[index]
      if (!original || original.name !== attempt.name) {
        throw new Error('Changed actual caller sequence')
      }
      const { bridge: _bridge, ...value } = attempt
      if (value.settlement.status === 'fulfilled') {
        value.settlement = {
          ...value.settlement,
          value: response(
            value.settlement.value,
            original.settlement.status === 'fulfilled' ? original.settlement.value : null,
            ids,
            replyMeta
          )
        }
      }
      return value
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this comparison-only copy retains the captured sender fields and changes only bound protocol response IDs.
    const actual: Observation = {
      ...after,
      sender: sender as unknown as RecordedValue,
      payloads: kept.map((row) => ({
        ...row,
        name: names.get(String(row.name)) ?? row.name,
        json: JSON.stringify({
          ...JSON.parse(String(row.json)),
          id: ids.get(JSON.parse(String(row.json)).id)
        })
      }))
    }
    const rank = (observation: Observation): Observation => {
      const events = [
        ...rows(observation.sender),
        ...rows(observation.payloads),
        ...rows(observation.effects)
      ]
      const ordinals = events.map((entry) => entry.ordinal)
      if (
        !ordinals.every((value) => typeof value === 'number') ||
        new Set(ordinals).size !== ordinals.length
      ) {
        throw new Error('Invalid retained TEST event order')
      }
      const map = (value: RecordedValue) =>
        rows(value).map((entry) => ({
          ...entry,
          ordinal: ordinals.filter((ordinal) => Number(ordinal) < Number(entry.ordinal)).length + 1
        }))
      return {
        ...observation,
        sender: map(observation.sender),
        payloads: map(observation.payloads),
        effects: map(observation.effects)
      }
    }
    return probeIds.size
      ? { expected: rank(before), actual: rank(actual) }
      : { expected: before, actual }
  }
  const views = expected.checkpoints.map((checkpoint, index) =>
    project(checkpoint.observation, raw.checkpoints[index]!.observation, checkpoint.id)
  )
  return {
    expected: {
      ...expected,
      checkpoints: expected.checkpoints.map((checkpoint, index) => ({
        ...checkpoint,
        observation: views[index]!.expected
      }))
    },
    actual: {
      ...raw,
      checkpoints: raw.checkpoints.map((checkpoint, index) => ({
        ...checkpoint,
        observation: views[index]!.actual
      }))
    }
  }
}

async function verdict(
  id: string,
  family: string,
  nativeScenarios: readonly RecordingScenario[],
  scenarios: readonly RecordingScenario[]
) {
  const native = await replay(id, nativeScenarios, 'native')
  const original = await replay(id, scenarios, 'page-original')
  const counterfactual = await replay(id, scenarios, 'page-reply-meta')
  for (const run of [native, original, counterfactual]) {
    if (run.didThrow) {
      throw run.thrown
    }
    if (!run.recording) {
      throw new Error(`Missing actual recording: ${id}`)
    }
  }
  const expected = readGolden(directory, id)
  compareGolden(expected, { ...expected, recording: native.recording! })
  const left = comparison(native.recording!, original.recording!, scenarios, false)
  const right = comparison(native.recording!, counterfactual.recording!, scenarios, true)
  const result = strictReplayVerdict(
    left.expected,
    scenarios,
    { ...original, comparison: left.actual },
    { ...counterfactual, comparison: right.actual }
  )
  expect(result.name, `${id}: ${JSON.stringify(result)}`).not.toBe('unclassified')
  observed.set(id, { family, domain: 'paired', verdict: result.name })
}

async function bridgeOnlyVerdict(
  id: string,
  family: string,
  scenarios: readonly RecordingScenario[]
) {
  for (const scenario of scenarios) {
    const operation = scenario.bridgeOperations?.[0]
    if (!operation) {
      throw new Error('Bridge-only input has no actual declared operation')
    }
    const original = await replay(scenario.id, [scenario], 'page-original')
    const counterfactual = await replay(scenario.id, [scenario], 'page-reply-meta')
    for (const run of [original, counterfactual]) {
      if (run.didThrow) {
        throw run.thrown
      }
      if (!run.recording) {
        throw new Error('Missing actual bridge-only recording')
      }
      const last = run.recording.checkpoints.at(-1)!.observation
      const parent = attempts(last).find((attempt) => attempt.name === operation.request)
      if (!parent || parent.bridge?.posts.length !== 1) {
        throw new Error('Missing actual bridge-only invocation')
      }
      const post = parent.bridge.posts[0]!
      const probe = post.children[0]!
      const posted: unknown = JSON.parse(post.json)
      if (!isKeyedObject(posted)) {
        throw new Error('Missing actual original post')
      }
      expect(posted.options).toEqual({ timeoutMs: 30_000, failWhenDisconnected: true })
      expect(probe.method).toBe('status.get')
      expect(probe.args).toEqual(
        captureArguments([
          'status.get',
          undefined,
          { timeoutMs: 30_000, failWhenDisconnected: true, beforeSend: () => {} }
        ])
      )
      const payloads = rows(last.payloads)
      const probeBytes = payloads.find((row) => row.name === probe.name)
      expect(probeBytes && JSON.parse(String(probeBytes.json))).toEqual({
        id: probe.frame!.id,
        deviceToken: 'recording-device',
        method: 'status.get'
      })
      const completion = scenario.steps.find(
        (step) => 'complete' in step && step.complete === operation.probeSite
      )
      if (scenario.lineage?.role === 'prelude') {
        expect(completion).toBeUndefined()
        expect(post.children.map((child) => child.method)).toEqual(['status.get'])
        expect(probe.completion).toBeUndefined()
        expect(probe.settlement).toMatchObject({
          status: 'rejected',
          error: { message: 'Connection closed', isRpcDeliveryUnknown: true }
        })
        expect(parent.settlement).toMatchObject({
          status: 'rejected',
          error: { category: 'BridgeClientClosedError', message: 'the page bridge was closed' }
        })
        continue
      }
      if (!completion || !('complete' in completion)) {
        throw new Error('Missing actual bridge-only completion')
      }
      const capable =
        isKeyedObject(completion.reply) &&
        completion.reply.ok === true &&
        isKeyedObject(completion.reply.result) &&
        Array.isArray(completion.reply.result.capabilities) &&
        completion.reply.result.capabilities.includes('github.exact-work-item-target.v1')
      expect(post.children.map((child) => child.method)).toEqual(
        capable ? [...operation.methods] : ['status.get']
      )
      expect(probe.completion!.reply).toEqual(captureValue(completion.reply))
      if (capable) {
        const child = post.children[1]!
        const step = scenario.steps.find(
          (step) => 'complete' in step && step.complete === child.name
        )
        if (!step || !('complete' in step)) {
          throw new Error('Forward has no actual scripted reply')
        }
        expect(child.completion!.reply).toEqual(captureValue(step.reply))
        expect(child.settlement.status).toBe('fulfilled')
        expect(parent.settlement.status).toBe('fulfilled')
        const request: unknown = JSON.parse(post.json)
        if (!isKeyedObject(request) || !isKeyedObject(request.envelope)) {
          throw new Error('Missing actual final-target envelope')
        }
        expect(request.params).toEqual(step.params)
        expect(payloads.find((row) => row.name === child.name)?.json).toBe(
          JSON.stringify({
            ...request.envelope,
            id: child.frame!.id,
            deviceToken: 'recording-device',
            method: request.method,
            params: request.params
          })
        )
        expect(probe.completion!.ordinal).toBeLessThan(child.ordinal)
      } else {
        const reply = completion.reply
        const message = completion.reject
          ? completion.reject.message
          : isKeyedObject(reply) && reply.ok === false && isKeyedObject(reply.error)
            ? reply.error.message
            : isKeyedObject(reply) && isKeyedObject(reply.result)
              ? GITHUB_EXACT_OPERATION_UNSUPPORTED
              : 'The host sent a reply this app could not read (status.get)'
        expect(parent.settlement).toMatchObject({ status: 'rejected', error: { message } })
        expect(post.replies).toHaveLength(1)
        expect(JSON.parse(post.replies[0]!.delivered!)).toMatchObject({
          type: 'error',
          id: post.id,
          error: { message }
        })
      }
    }
    const before = original.recording!,
      after = counterfactual.recording!
    expect(after.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(
      before.checkpoints.map((checkpoint) => checkpoint.id)
    )
    for (const [index, checkpoint] of before.checkpoints.entries()) {
      const actual = after.checkpoints[index]!.observation
      expect(actual.state).toEqual(checkpoint.observation.state)
      expect(actual.effects).toEqual(checkpoint.observation.effects)
      expect(actual.settlements).toEqual(checkpoint.observation.settlements)
      expect(actual.payloads).toEqual(checkpoint.observation.payloads)
      const baseline = attempts(checkpoint.observation)
      const ids = new Map(
        baseline.flatMap((attempt) =>
          attempt.bridge!.posts.flatMap((post) =>
            post.children.flatMap((child) =>
              child.frame ? [[child.frame.id, child.frame.id] as const] : []
            )
          )
        )
      )
      for (const [at, attempt] of attempts(actual).entries()) {
        const previous = baseline[at]!
        const { bridge: _left, ...expected } = previous
        const { bridge: _right, ...value } = attempt
        if (value.settlement.status === 'fulfilled') {
          value.settlement = {
            ...value.settlement,
            value: response(
              value.settlement.value,
              previous.settlement.status === 'fulfilled' ? previous.settlement.value : null,
              ids,
              true
            )
          }
        }
        expect(value).toEqual(expected)
        expect(attempt.bridge!.posts.map((post) => post.json)).toEqual(
          previous.bridge!.posts.map((post) => post.json)
        )
        for (const [postAt, post] of attempt.bridge!.posts.entries()) {
          const earlier = previous.bridge!.posts[postAt]!
          expect(post.children).toEqual(earlier.children)
          expect(post.replies.map((reply) => reply.delivered)).toEqual(
            earlier.replies.map((reply) => withReplyMeta(reply.json))
          )
        }
      }
    }
  }
  observed.set(id, { family, domain: 'bridge-only', verdict: { verdict: 'bridge-contract' } })
}

describe.skipIf(process.env[BRIDGED_PARITY_FLAG] === BRIDGED_PARITY_OFF)(
  'native recordings through the actual page bridge',
  () => {
    const native = new Map(
      [...pilotGoldens(input.scenarios), ...familyGoldens(input.scenarios)].map((producer) => [
        producer.id,
        producer
      ])
    )
    for (const pilot of pilotGoldens(input.scenarios, 'bridge')) {
      it(`${pilot.id}: bridged parity`, async () => {
        await verdict(pilot.id, pilot.family, native.get(pilot.id)!.scenarios(), [pilot.scenario])
      })
    }
    for (const golden of familyGoldens(input.scenarios, 'bridge')) {
      it(
        `${golden.id}: bridged parity`,
        async () => {
          if (golden.lineage.domain === 'bridge-only') {
            await bridgeOnlyVerdict(golden.id, golden.family, golden.scenarios())
          } else {
            await verdict(
              golden.id,
              golden.family,
              native.get(golden.id)!.scenarios(),
              golden.scenarios()
            )
          }
        },
        // Replay every real native/page-original/page-reply-meta partition within the family's allowance.
        golden.timeoutMs
      )
    }
    afterCorpus(
      'gives every golden the C5 page closure records the verdict it is pinned to',
      () => {
        const paired = new Map([...observed].filter(([, run]) => run.domain !== 'bridge-only'))
        process.stdout.write(readPageClosure('C5', C5_PAGE_CLOSURE, paired))
        expect({ closure: pageClosureDrift(C5_PAGE_CLOSURE, paired) }).toEqual({ closure: [] })
      }
    )
    afterCorpus(
      'gives every golden the C2 page closure records the verdict it is pinned to',
      () => {
        const paired = new Map([...observed].filter(([, run]) => run.domain !== 'bridge-only'))
        process.stdout.write(readPageClosure('C2', C2_PAGE_CLOSURE, paired))
        expect({ closure: pageClosureDrift(C2_PAGE_CLOSURE, paired) }).toEqual({ closure: [] })
      }
    )
    afterCorpus(
      'gives every golden the C6 browser closure records the verdict it is pinned to',
      () => {
        const paired = new Map([...observed].filter(([, run]) => run.domain !== 'bridge-only'))
        process.stdout.write(readPageClosure('C6', C6_BROWSER_CLOSURE_FAMILIES, paired))
        expect({ closure: pageClosureDrift(C6_BROWSER_CLOSURE_FAMILIES, paired) }).toEqual({
          closure: []
        })
      }
    )
    afterCorpus(
      'gives every golden the C3 page closure records the verdict it is pinned to',
      () => {
        const paired = new Map([...observed].filter(([, run]) => run.domain !== 'bridge-only'))
        process.stdout.write(readPageClosure('C3', C3_PAGE_CLOSURE, paired))
        expect({ closure: pageClosureDrift(C3_PAGE_CLOSURE, paired) }).toEqual({ closure: [] })
      }
    )
  }
)

afterAll(() => {
  const errors: unknown[] = []
  for (const check of corpusChecks) {
    try {
      check()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Page closure drift')
  }
})
