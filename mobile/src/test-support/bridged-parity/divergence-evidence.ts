import type { BridgeRpcClientDiagnostic } from '../../mobile-web-shell/bridge/bridge-rpc-client'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import { firstDifference } from '../rpc-recording/golden-recording'
import { canonicalJson, OBSERVATION_FIELDS } from '../rpc-recording/golden-value-pool'
import type { Observation, Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import { captureValue, type RecordedValue } from '../rpc-recording/recording-values'
import type { ParamsMismatchEvidence } from './divergence-classes'

/**
 * The facts a divergence is named from, each read off the run rather than off its message.
 *
 * Outside the recorder's directory for the reason `divergence-classes.ts` gives: none of this can
 * change what a recording records, so none of it belongs in the digest that says what can.
 */

/** Frames the shell posted that the page's own reader drops. Read back through that same reader. */
export function refusedFrames(posted: readonly string[]): string[] {
  return posted.filter((json) => !readBridgeHostMessage(json).ok)
}

/**
 * The same frame with a `_meta` on its reply payload, which is the one field the page's reader
 * demands and the wire the page stands in for does not. Anything that is not a reply comes back
 * untouched, so this can sit on a whole lane. The type is what decides that and not the presence of
 * a `payload`: an `event` carries one too, and the page reads it as `z.unknown()`, so stamping it
 * would put a key in a subscription's bytes that no reader asked for and none would refuse.
 */
export function withReplyMeta(json: string): string {
  const frame: unknown = JSON.parse(json)
  if (typeof frame !== 'object' || frame === null || !('payload' in frame)) {
    return json
  }
  if (!('type' in frame) || frame.type !== 'reply') {
    return json
  }
  const payload = frame.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json
  }
  return JSON.stringify({
    ...frame,
    payload: { ...payload, _meta: { runtimeId: 'counterfactual-runtime' } }
  })
}

/**
 * Every `_meta` the counterfactual added, gone again.
 *
 * A reply the page accepted resolves to the caller whole, `_meta` included, so a run that was given
 * the field records it where the faithful run records nothing. Removing it is what makes the two
 * runs comparable; it is a key the recorder never sees on this corpus, so nothing else is lost.
 */
export function withoutRpcMeta(value: RecordedValue): RecordedValue {
  if (Array.isArray(value)) {
    return value.map(withoutRpcMeta)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '_meta')
      .map(([key, entry]) => [key, withoutRpcMeta(entry)])
  )
}

/** A recording with the counterfactual's fingerprints removed, ready to diff against a golden. */
export function recordingWithoutRpcMeta(recording: Recording): Recording {
  return {
    scenario: recording.scenario,
    checkpoints: recording.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `withoutRpcMeta` preserves shape, so an observation maps to an observation.
      observation: withoutRpcMeta(checkpoint.observation) as Observation
    }))
  }
}

/**
 * Every field path that differs, in the vocabulary `compareGolden` prints, and `checkpoints` when
 * the two runs did not even reach the same checkpoints. All of them, not the first: a rule that
 * needs to know whether *every* field that moved is an ordinal cannot be given only one.
 */
export function divergingFields(expected: Recording, actual: Recording): string[] {
  const expectedIds = expected.checkpoints.map((checkpoint) => checkpoint.id)
  const actualIds = actual.checkpoints.map((checkpoint) => checkpoint.id)
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    return ['checkpoints']
  }
  const fields: string[] = []
  for (const [index, checkpoint] of expected.checkpoints.entries()) {
    const found = actual.checkpoints[index]
    if (found === undefined) {
      return ['checkpoints']
    }
    for (const field of OBSERVATION_FIELDS) {
      const mine = checkpoint.observation[field]
      const theirs = found.observation[field]
      if (canonicalJson(mine) === canonicalJson(theirs)) {
        continue
      }
      fields.push(`${field}${firstDifference(mine, theirs).path}`)
    }
  }
  return fields
}

/** A reply shape the wire itself drops: `ok` with no `result` key at all. */
export function scriptsAbsentResultReply(scenario: RecordingScenario): boolean {
  return scenario.steps.some((step) => {
    if (!('reply' in step) || typeof step.reply !== 'object' || step.reply === null) {
      return false
    }
    return 'ok' in step.reply && step.reply.ok === true && !('result' in step.reply)
  })
}

/**
 * The page refused a frame on a stream it was holding, and let the stream go because of it.
 *
 * Read as a pair and in order: `stream-failed` alone is also what an `error` frame from the shell
 * reports, and that one is the shell saying it has already retired the stream. Only a refusal
 * followed by a release is the page giving up on a stream the shell is still serving.
 */
export function refusalReleasedStream(diagnostics: readonly BridgeRpcClientDiagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic, index) =>
      diagnostic.kind === 'refused' && diagnostics[index + 1]?.kind === 'stream-failed'
  )
}

/** The name the scripted transport prints for a request whose params stopped matching. */
const REQUEST_PARAMS_MISMATCH = /^Request params mismatch: (?<method>.+)#(?<occurrence>\d+)$/

function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The comparison the transport itself made: `captureValue` is what it matches a step against. */
function sameParams(left: unknown, right: unknown): boolean {
  return JSON.stringify(captureValue(left)) === JSON.stringify(captureValue(right))
}

/** Own key paths whose value is `undefined`, in the vocabulary `firstDifference` prints. */
function undefinedValuedPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      entry === undefined ? [`${path}[${index}]`] : undefinedValuedPaths(entry, `${path}[${index}]`)
    )
  }
  if (!isKeyedObject(value)) {
    return []
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    entry === undefined ? [`${path}.${key}`] : undefinedValuedPaths(entry, `${path}.${key}`)
  )
}

/**
 * Every path where two params differ, all of them, and never the parent of one.
 *
 * A key present on one side alone is the difference and is not walked into: an absent key and a key
 * valued `undefined` are the same value to `captureValue` and only their presence tells them apart,
 * which is the whole difference this class exists to name.
 */
function differingParamPaths(scripted: unknown, arrived: unknown, path = ''): string[] {
  if (sameParams(scripted, arrived)) {
    return []
  }
  if (Array.isArray(scripted) && Array.isArray(arrived) && scripted.length === arrived.length) {
    return scripted.flatMap((entry, index) =>
      differingParamPaths(entry, arrived[index], `${path}[${index}]`)
    )
  }
  if (isKeyedObject(scripted) && isKeyedObject(arrived)) {
    return [...new Set([...Object.keys(scripted), ...Object.keys(arrived)])]
      .sort()
      .flatMap((key) =>
        key in scripted && key in arrived
          ? differingParamPaths(scripted[key], arrived[key], `${path}.${key}`)
          : [`${path}.${key}`]
      )
  }
  return [path]
}

/** The params of the `index`th request the page posted for `method`, absent arity included. */
function postedRequestParams(
  posted: readonly string[],
  method: string,
  index: number
): { found: true; params: unknown } | { found: false } {
  const frames = posted
    .map((json): unknown => JSON.parse(json))
    .filter((frame) => isKeyedObject(frame) && frame.type === 'request' && frame.method === method)
  const frame = frames[index]
  if (!isKeyedObject(frame)) {
    return { found: false }
  }
  return { found: true, params: frame.params }
}

/**
 * What the transport refused, read off the scenario and the frames rather than off the message.
 *
 * Null for anything that is not one request's params being refused, and null again when the step it
 * names cannot be lined up with a frame the page posted — both leave the golden unclassified, which
 * is loud, rather than excluded, which is silent.
 */
export function paramsMismatchEvidence(
  thrown: unknown,
  scenario: RecordingScenario | undefined,
  postedToShell: readonly string[]
): ParamsMismatchEvidence | null {
  const named = thrown instanceof Error ? REQUEST_PARAMS_MISMATCH.exec(thrown.message) : null
  const method = named?.groups?.method
  if (method === undefined || scenario === undefined) {
    return null
  }
  const step = `${method}#${named?.groups?.occurrence}`
  // Among that method's own completions, because the transport's occurrence counter also counts the
  // subscribe payloads a scenario publishes, and neither list carries the other's members.
  const completions = scenario.steps.filter(
    (candidate) => 'complete' in candidate && candidate.complete.startsWith(`${method}#`)
  )
  const at = completions.findIndex(
    (candidate) => 'complete' in candidate && candidate.complete === step
  )
  const scripted = completions[at]
  if (at === -1 || scripted === undefined || !('params' in scripted)) {
    return null
  }
  const arrived = postedRequestParams(postedToShell, method, at)
  if (!arrived.found) {
    return null
  }
  return {
    step,
    undefinedValuedKeys: undefinedValuedPaths(scripted.params),
    differingKeys: differingParamPaths(scripted.params, arrived.params)
  }
}
