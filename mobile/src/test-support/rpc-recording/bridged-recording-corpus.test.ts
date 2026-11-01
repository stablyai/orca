import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../../src/shared/github/work-item-target'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/types'
import {
  bridgedParityMembershipDrift,
  BRIDGED_PARITY_BASELINE,
  BRIDGED_PARITY_EXCLUSIONS,
  BRIDGED_PARITY_FLAG,
  BRIDGED_PARITY_NAMEABLE,
  BRIDGED_PARITY_OFF,
  classifyBridgedParity,
  type BridgedParityClass,
  type BridgedParityEvidence
} from '../bridged-parity/divergence-classes'
import { C5_PAGE_CLOSURE } from '../bridged-parity/c5-page-closure'
import { C6_BROWSER_CLOSURE_FAMILIES } from '../bridged-parity/c6-browser-closure-families'
import { C2_PAGE_CLOSURE } from '../bridged-parity/c2-page-closure'
import { C3_PAGE_CLOSURE } from '../bridged-parity/c3-page-closure'
import {
  pageClosureDrift,
  readPageClosure,
  type BridgedParityVerdict,
  type PageClosureObservation
} from '../bridged-parity/page-closure'
import { strictReplayVerdict, type BridgedReplay } from '../bridged-parity/replay-verdict'
import {
  divergingFields,
  isKeyedObject,
  paramsMismatchEvidence,
  refusalReleasedStream,
  refusedFrames,
  scriptsAbsentResultReply,
  withReplyMeta
} from '../bridged-parity/divergence-evidence'
import {
  CHANGED_PRODUCERS,
  expectedUnchangedTally,
  NATIVE_ONLY_CHANGED,
  refusedReplyExpectation,
  rows,
  STRICT_OWN_UNDEFINED
} from './changed-bridge-outcomes'
import { familyGoldens, pilotGoldens, type DerivedGolden } from './derived-goldens'
import { compareGolden, readGolden } from './golden-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import type { Recording, RecordingScenario } from './recording-scenario'
import { RecordingParamsMismatch, RecordingStreamGuard } from './recording-mismatch'
import { captureArguments, captureValue, type RecordedValue } from './recording-values'
import { readScenarios } from './scenario-input'
import { runRecording } from './run-recording'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { attempts, comparison, response } from './bridged-replay-comparison'

// Replay every producer through the actual page bridge. Unchanged members keep main's limited verdicts and
// bounded tally; changed members and bridge-only probes earn direct outcomes; every producer is routed once.

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

type Route = 'unchanged' | 'direct' | 'bridge-only'
const accounted = new Map<string, Route[]>()
function account(id: string, route: Route) {
  accounted.set(id, [...(accounted.get(id) ?? []), route])
}
const counts: Record<BridgedParityClass, number> = {
  'reply-meta-required': 0,
  'result-absent-settlement': 0,
  'result-absent-observation': 0,
  'result-absent-stream-release': 0,
  'params-undefined': 0,
  'write-ordinal': 0,
  unclassified: 0
}
let identical = 0
const members = new Map<BridgedParityClass, string[]>()
const samples = new Map<BridgedParityClass, string>()
const changed = new Set(CHANGED_PRODUCERS)
const strictOwnUndefined = new Set(STRICT_OWN_UNDEFINED)

type PageMode = 'page-original' | 'page-reply-meta'

async function replay(
  id: string,
  scenarios: readonly RecordingScenario[],
  mode: PageMode,
  keepClient?: (client: RpcClient) => RpcClient
): Promise<BridgedReplay> {
  const pairs: BridgePortPair<RpcClient>[] = []
  const checkpoints: Recording['checkpoints'] = []
  try {
    for (const scenario of scenarios) {
      const recording = await runRecording(
        scenario,
        pilotMountAdapters(root, { device: scenario }).adapters[scenario.operation]!,
        vitestRecordingScheduler({ producer: id, scenario: scenario.id }),
        (rpc, observation) => {
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
          return keepClient ? keepClient(pair.client) : pair.client
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

const AFTER_PRELUDE_ACTION = 'bridge-only-after-prelude-action'
const PRELUDE_TEARDOWN_MESSAGE = 'Connection closed'
const PRELUDE_TEARDOWN_DELIVERY_UNKNOWN = true

// Only a bare typed guard is evidence; capture, scheduler, transparent-call or added cleanup failures stay fatal.
function admitThrown(run: BridgedReplay): void {
  if (
    run.didThrow &&
    !(run.thrown instanceof RecordingParamsMismatch) &&
    !(run.thrown instanceof RecordingStreamGuard)
  ) {
    throw run.thrown
  }
}

// Compare an unchanged producer as main did: the page-facing caller and the native frames, without the recorder's
// bridge field, with child frames named by their actual parent invocation.
function unchangedView(raw: Recording): Recording {
  return {
    ...raw,
    checkpoints: raw.checkpoints.map((checkpoint) => {
      const parents = new Map<string, string>()
      const sender = attempts(checkpoint.observation).map((attempt) => {
        for (const post of attempt.bridge?.posts ?? []) {
          for (const child of post.children) {
            parents.set(child.name, attempt.name)
          }
        }
        const { bridge: _bridge, ...value } = attempt
        return value
      })
      return {
        ...checkpoint,
        observation: {
          ...checkpoint.observation,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attempts without their bridge field are recorded values.
          sender: sender as unknown as RecordedValue,
          payloads: rows(checkpoint.observation.payloads).map((row) => ({
            ...row,
            name: parents.get(String(row.name)) ?? row.name
          }))
        }
      }
    })
  }
}

// Remove only the counterfactual envelope metadata the reply-meta run injected into a caller's reply; product
// copies of it remain data.
function withoutInjectedReplyMeta(view: Recording, expected: Recording): Recording {
  return {
    ...view,
    checkpoints: view.checkpoints.map((checkpoint, index) => {
      const before = expected.checkpoints[index]
      const originals = before ? rows(before.observation.sender) : []
      return {
        ...checkpoint,
        observation: {
          ...checkpoint.observation,
          sender: rows(checkpoint.observation.sender).map((attempt, at) => {
            const settlement = attempt.settlement
            const original = originals[at]?.settlement
            if (
              !isKeyedObject(settlement) ||
              !isKeyedObject(settlement.value) ||
              typeof settlement.value.ok !== 'boolean' ||
              !isKeyedObject(settlement.value._meta) ||
              Object.keys(settlement.value._meta).length !== 1 ||
              settlement.value._meta.runtimeId !== 'counterfactual-runtime' ||
              (isKeyedObject(original) &&
                isKeyedObject(original.value) &&
                Object.hasOwn(original.value, '_meta'))
            ) {
              return attempt
            }
            const { _meta: _injected, ...value } = settlement.value
            return { ...attempt, settlement: { ...settlement, value } }
          })
        }
      }
    })
  }
}

function explain(fields: readonly string[], run: BridgedReplay): string {
  const refused = refusedFrames(run.pairs.flatMap((pair) => pair.toPage))
  const [refusal] = refused
  const read = refusal === undefined ? null : readBridgeHostMessage(refusal)
  const kinds = run.pairs.flatMap((pair) => pair.diagnostics).map((diagnostic) => diagnostic.kind)
  return [
    `  fields    ${fields.slice(0, 4).join(', ') || '(none)'}`,
    `  threw     ${run.thrown instanceof Error ? run.thrown.message : '(nothing)'}`,
    `  refused   ${refused.length} frame(s)${
      read !== null && !read.ok ? `, first "${read.refusal}" on ${refusal?.slice(0, 200)}` : ''
    }`,
    `  page saw  ${kinds.join(', ') || '(no diagnostics)'}`
  ].join('\n')
}

function record(id: string, family: string, verdict: BridgedParityVerdict, route: Route) {
  observed.set(id, {
    family,
    domain: route === 'bridge-only' ? 'bridge-only' : 'paired',
    verdict
  })
  account(id, route)
}

function tally(
  id: string,
  family: string,
  name: BridgedParityClass,
  fields: string[],
  run: BridgedReplay
) {
  counts[name] += 1
  record(id, family, name, 'unchanged')
  members.set(name, [...(members.get(name) ?? []), id])
  if (!samples.has(name)) {
    samples.set(name, `${id}\n${explain(fields, run)}`)
  }
}

const HISTORY = new Set([
  ...Object.keys(C5_PAGE_CLOSURE['aiVault.history'] ?? {}),
  ...Object.keys(C5_PAGE_CLOSURE['aiVault.history-screen'] ?? {})
])

// Main's decision order: identical earns identical; History keeps its strict certified path; every other
// divergence is a legacy label read from the reply-meta counterfactual's evidence.
async function unchangedVerdict(
  id: string,
  family: string,
  scenarios: readonly RecordingScenario[]
) {
  const expected = readGolden(directory, id)
  const run = await replay(id, scenarios, 'page-original')
  admitThrown(run)
  if (HISTORY.has(id)) {
    const asIf = await replay(id, scenarios, 'page-reply-meta')
    for (const replayed of [run, asIf]) {
      if (replayed.didThrow) {
        throw replayed.thrown
      }
    }
    const left = comparison(input.scenarios, expected.recording, run.recording!, scenarios, false)
    const right = comparison(input.scenarios, expected.recording, asIf.recording!, scenarios, true)
    const result = strictReplayVerdict(
      left.expected,
      scenarios,
      { ...run, comparison: left.actual },
      { ...asIf, comparison: right.actual }
    )
    if (result.name === 'unclassified') {
      throw new Error(
        `Unclassified bridged divergence: ${id}\noriginal (${result.original.name}):\n${explain(result.original.fields, run)}\nwith \`_meta\` supplied (${result.replyMeta.name}):\n${explain(result.replyMeta.fields, asIf)}`
      )
    }
    if (result.name === 'identical') {
      identical += 1
      record(id, family, 'identical', 'unchanged')
      return
    }
    tally(id, family, result.name, result.original.fields, run)
    return
  }
  const view = run.recording === null ? null : unchangedView(run.recording)
  const fields = view === null ? [] : divergingFields(expected.recording, view)
  if (view !== null && fields.length === 0) {
    // Not redundant with the field walk: this one also pins the encoding.
    compareGolden(expected, { ...expected, recording: view })
    identical += 1
    record(id, family, 'identical', 'unchanged')
    return
  }
  const asIf = await replay(id, scenarios, 'page-reply-meta')
  admitThrown(asIf)
  const asIfView =
    asIf.recording === null
      ? null
      : withoutInjectedReplyMeta(unchangedView(asIf.recording), expected.recording)
  const asIfFields = asIfView === null ? [] : divergingFields(expected.recording, asIfView)
  const scriptsAbsent = scenarios.some(scriptsAbsentResultReply)
  const evidence: BridgedParityEvidence = {
    fixedByReplyMeta: asIfView !== null && asIfFields.length === 0,
    threwWhileRecording: asIf.recording === null,
    divergingFields: asIfFields,
    absentResultExplainsResiduals: false,
    paramsMismatch: paramsMismatchEvidence(asIf.thrown),
    refusalReleasedStream:
      scriptsAbsent && asIf.pairs.some((pair) => refusalReleasedStream(pair.diagnostics)),
    legacyBaseline: {
      firstField:
        asIfView === null ? undefined : divergingFields(expected.recording, asIfView, false)[0],
      scriptsAbsentResultReply: scriptsAbsent
    }
  }
  const name = classifyBridgedParity(evidence)
  if (name === 'unclassified') {
    throw new Error(
      `Unclassified bridged divergence: ${id}\n${explain(fields, run)}\nwith \`_meta\` supplied:\n${explain(asIfFields, asIf)}`
    )
  }
  tally(id, family, name, fields, run)
}

// A changed member's strict own-undefined stop: the typed guard, keys that differ only by an own undefined value,
// and the identical bytes the page posted.
function expectStrictOwnUndefinedStop(id: string, mode: PageMode, run: BridgedReplay) {
  const context = `${id}/${mode}`
  expect(run.thrown, context).toBeInstanceOf(RecordingParamsMismatch)
  const mismatch = run.thrown
  if (!(mismatch instanceof RecordingParamsMismatch)) {
    throw new Error(`Missing actual strict params guard: ${context}`)
  }
  const evidence = paramsMismatchEvidence(mismatch)!
  expect(evidence.differingKeys.length, context).toBeGreaterThan(0)
  expect(
    evidence.differingKeys.filter((key) => !evidence.undefinedValuedKeys.includes(key)),
    context
  ).toEqual([])
  const bytes = JSON.stringify(mismatch.actual)
  expect(JSON.stringify(mismatch.expected), context).toBe(bytes)
  const posted = run.pairs
    .flatMap((pair) => pair.toShell)
    .map((json): unknown => JSON.parse(json))
    .filter(
      (frame) =>
        isKeyedObject(frame) && frame.type === 'request' && frame.method === mismatch.method
    )
  expect(posted.length, context).toBeGreaterThan(0)
  const last = posted.at(-1)
  expect(isKeyedObject(last) ? JSON.stringify(last.params) : undefined, context).toBe(bytes)
}

// Changed members earn their own outcome in both page modes: the reviewed native golden, with the page's
// refusal of the injected absent result applied where the product copies it, and nothing else may differ.
async function directVerdict(id: string, family: string, scenarios: readonly RecordingScenario[]) {
  const expected = readGolden(directory, id)
  for (const mode of ['page-original', 'page-reply-meta'] as const) {
    const run = await replay(id, scenarios, mode)
    if (strictOwnUndefined.has(id)) {
      expectStrictOwnUndefinedStop(id, mode, run)
      continue
    }
    if (run.didThrow || !run.recording) {
      throw run.thrown
    }
    const view = comparison(
      expected.recording,
      run.recording,
      scenarios,
      mode === 'page-reply-meta'
    )
    const want = refusedReplyExpectation(view.expected, scenarios)
    const fields = divergingFields(want, view.actual)
    if (fields.length) {
      throw new Error(`Changed bridged outcome differs: ${id}/${mode}\n${explain(fields, run)}`)
    }
  }
  record(id, family, { verdict: 'bridge-contract' }, 'direct')
}
async function bridgeOnlyVerdict(
  id: string,
  family: string,
  scenarios: readonly RecordingScenario[]
) {
  for (const source of scenarios) {
    const operation = source.bridgeOperations?.[0]
    if (!operation) {
      throw new Error('Bridge-only input has no actual declared operation')
    }
    const prelude = source.lineage?.role === 'prelude'
    // A prelude ends on the action whose probe is still pending; observe it after the whole tail.
    const scenario: RecordingScenario = prelude
      ? { ...source, steps: [...source.steps, { checkpoint: AFTER_PRELUDE_ACTION }] }
      : source
    const runs: { run: BridgedReplay; calls: Promise<RpcResponse>[] }[] = []
    for (const mode of ['page-original', 'page-reply-meta'] as const) {
      const calls: Promise<RpcResponse>[] = []
      // Keep each actual page RPC promise, in invocation order, from the unchanged page client.
      const run = await replay(scenario.id, [scenario], mode, (client) => ({
        ...client,
        sendRequest: (...args: Parameters<RpcClient['sendRequest']>) => {
          const promise = client.sendRequest(...args)
          calls.push(promise)
          return promise
        }
      }))
      runs.push({ run, calls })
    }
    const original = runs[0]!.run
    const counterfactual = runs[1]!.run
    for (const { run, calls } of runs) {
      if (run.didThrow) {
        throw run.thrown
      }
      if (!run.recording) {
        throw new Error('Missing actual bridge-only recording')
      }
      const last = prelude
        ? run.recording.checkpoints.find((checkpoint) => checkpoint.id === AFTER_PRELUDE_ACTION)
            ?.observation
        : run.recording.checkpoints.at(-1)?.observation
      if (!last) {
        throw new Error('Missing actual bridge-only observation')
      }
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
      if (prelude) {
        // After the action, before teardown: one bound post whose probe is still pending, and nothing forwarded.
        expect(completion).toBeUndefined()
        expect(post.children.map((child) => child.method)).toEqual(['status.get'])
        expect(probe.completion).toBeUndefined()
        expect(probe.settlement.status).toBe('pending')
        expect(parent.settlement.status).toBe('pending')
        expect(post.replies).toEqual([])
        // Teardown closes the native connection first, so this caller gets its relayed rejection.
        const call = calls[attempts(last).indexOf(parent)]
        if (!call) {
          throw new Error('Missing the actual page RPC promise')
        }
        const outcome = await call.then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        )
        if (!('error' in outcome)) {
          throw new Error('The pending bridge-only invocation resolved at teardown')
        }
        expect(outcome.error).toMatchObject({ message: PRELUDE_TEARDOWN_MESSAGE })
        expect(isRpcDeliveryUnknown(outcome.error)).toBe(PRELUDE_TEARDOWN_DELIVERY_UNKNOWN)
        expect(
          run.pairs
            .flatMap((pair) => pair.toPage)
            .map((json): unknown => JSON.parse(json))
            .filter((frame) => isKeyedObject(frame) && frame.id === post.id)
        ).toMatchObject([{ type: 'error', error: { message: PRELUDE_TEARDOWN_MESSAGE } }])
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
  record(id, family, { verdict: 'bridge-contract' }, 'bridge-only')
}

function total(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, count) => sum + count, 0)
}

function asClass(name: string): BridgedParityClass {
  if (!(name in counts)) {
    throw new Error(`Not a bridged parity class: ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `name in counts` was just checked, and `counts` has exactly the union's keys.
  return name as BridgedParityClass
}

function routeOf(golden: DerivedGolden): Route {
  return golden.lineage.domain === 'bridge-only'
    ? 'bridge-only'
    : changed.has(golden.id)
      ? 'direct'
      : 'unchanged'
}

describe.skipIf(process.env[BRIDGED_PARITY_FLAG] === BRIDGED_PARITY_OFF)(
  'native recordings through the actual page bridge',
  () => {
    const producers: DerivedGolden[] = [
      ...pilotGoldens(input.scenarios, 'bridge'),
      ...familyGoldens(input.scenarios, 'bridge')
    ]
    for (const golden of producers) {
      it(
        `${golden.id}: bridged parity`,
        async () => {
          const route = routeOf(golden)
          const scenarios = golden.scenarios()
          await (route === 'bridge-only'
            ? bridgeOnlyVerdict(golden.id, golden.family, scenarios)
            : route === 'direct'
              ? directVerdict(golden.id, golden.family, scenarios)
              : unchangedVerdict(golden.id, golden.family, scenarios))
        },
        // Replay every real page-original/page-reply-meta partition within the family's allowance.
        golden.timeoutMs
      )
    }
    afterCorpus('routes every producer exactly once', () => {
      const discovered = producers.map((golden) => golden.id)
      const duplicated = discovered.filter((id, index) => discovered.indexOf(id) !== index)
      const missing = discovered.filter((id) => !accounted.has(id))
      const twice = [...accounted].filter(([, routes]) => routes.length !== 1).map(([id]) => id)
      // Changed producers either replay here or are declared native-only sites with no page producer.
      const unrouted = CHANGED_PRODUCERS.filter(
        (id) => !discovered.includes(id) && !NATIVE_ONLY_CHANGED.includes(id)
      )
      const nativeOnlyReplayed = NATIVE_ONLY_CHANGED.filter((id) => discovered.includes(id))
      expect({ duplicated, missing, twice, unrouted, nativeOnlyReplayed }).toEqual({
        duplicated: [],
        missing: [],
        twice: [],
        unrouted: [],
        nativeOnlyReplayed: []
      })
    })
    afterCorpus('keeps the unchanged corpus within its legacy labels and bounded tally', () => {
      const table = [
        `identical ${identical}`,
        ...Object.entries(counts).map(([name, count]) => {
          const named = members.get(asClass(name)) ?? []
          return count > 0 && count <= BRIDGED_PARITY_NAMEABLE
            ? `${name} ${count}: ${named.join(', ')}`
            : `${name} ${count}`
        })
      ].join('\n')
      const excluded = Object.entries(counts).filter(
        ([name]) => BRIDGED_PARITY_EXCLUSIONS[asClass(name)] !== undefined
      )
      const excludedCount = total(Object.fromEntries(excluded))
      process.stdout.write(
        `\nunchanged corpus over ${identical + total(counts)} goldens; labels are recorder limitations, not parity\n${table}\n`
      )
      for (const [name, sample] of samples) {
        process.stdout.write(`\n${name} sample\n${sample}\n`)
      }
      expect(counts.unclassified).toBe(0)
      // Pin membership: one real refusal can enter an excluded class while another leaves without changing totals.
      expect({ membership: bridgedParityMembershipDrift(members) }).toEqual({ membership: [] })
      expect({ divergedOutsideAnExcludedClass: total(counts) - excludedCount }).toEqual({
        divergedOutsideAnExcludedClass: 0
      })
      // Branch-base totals less each named moved or removed member's own base class.
      const { expected, pending } = expectedUnchangedTally(BRIDGED_PARITY_BASELINE)
      const ran: Record<string, number> = { ...counts, identical }
      const shortfall = Object.entries(expected).map(
        ([name, count]) => [name, count - (ran[name] ?? 0)] as const
      )
      // Until each pending member's base class is known, the tally may differ only by those members.
      expect({
        tally: shortfall.filter(([, short]) => (pending.length ? short < 0 : short !== 0)),
        pendingTotal: total(Object.fromEntries(shortfall))
      }).toEqual({ tally: [], pendingTotal: pending.length })
      expect({ oldClassPending: pending }).toEqual({ oldClassPending: [] })
    })
    for (const [name, pins] of [
      ['C5', C5_PAGE_CLOSURE],
      ['C2', C2_PAGE_CLOSURE],
      ['C6', C6_BROWSER_CLOSURE_FAMILIES],
      ['C3', C3_PAGE_CLOSURE]
    ] as const) {
      afterCorpus(
        `gives every golden the ${name} closure records the verdict it is pinned to`,
        () => {
          const paired = new Map([...observed].filter(([, run]) => run.domain !== 'bridge-only'))
          process.stdout.write(readPageClosure(name, pins, paired))
          expect({ closure: pageClosureDrift(pins, paired) }).toEqual({ closure: [] })
        }
      )
    }
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
    throw new AggregateError(errors, 'Bridged corpus guard failed')
  }
})
