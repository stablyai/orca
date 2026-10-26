import type { BridgeRpcClientDiagnostic } from '../../mobile-web-shell/bridge/bridge-rpc-client'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import { firstDifference } from '../rpc-recording/golden-difference'
import { canonicalJson, OBSERVATION_FIELDS } from '../rpc-recording/golden-value-pool'
import type { Observation, Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import { captureValue, type RecordedValue } from '../rpc-recording/recording-values'
import type { ParamsMismatchEvidence } from './divergence-classes'

// Analyze recorded evidence outside the recorder so observation cannot alter capture.

export function refusedFrames(posted: readonly string[]): string[] {
  return posted.filter((json) => !readBridgeHostMessage(json).ok)
}

/** Adds counterfactual reply metadata, leaving events and other frames unchanged. */
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

// Remove added meta before comparing runs; this corpus never otherwise records that key.
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

// Collect every differing field; proving all changes are ordinals requires more than the first difference.
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

export function scriptsAbsentResultReply(scenario: RecordingScenario): boolean {
  return scenario.steps.some((step) => {
    if (!('reply' in step) || typeof step.reply !== 'object' || step.reply === null) {
      return false
    }
    return 'ok' in step.reply && step.reply.ok === true && !('result' in step.reply)
  })
}

// Require refusal followed by stream failure; failure alone may mean the shell already retired the stream.
export function refusalReleasedStream(diagnostics: readonly BridgeRpcClientDiagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic, index) =>
      diagnostic.kind === 'refused' && diagnostics[index + 1]?.kind === 'stream-failed'
  )
}

const REQUEST_PARAMS_MISMATCH = /^Request params mismatch: (?<method>.+)#(?<occurrence>\d+)$/

function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Use the transport’s own captureValue comparison so mismatch evidence matches its semantics.
function sameParams(left: unknown, right: unknown): boolean {
  return JSON.stringify(captureValue(left)) === JSON.stringify(captureValue(right))
}

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

// Preserve missing-key differences without descending: absent and undefined share a captured value but differ in key presence.
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

// Unalignable mismatch evidence stays unclassified and loud instead of receiving a silent exclusion.
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
  // Align method completions only; the occurrence counter also includes subscriptions that are absent from request frames.
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
