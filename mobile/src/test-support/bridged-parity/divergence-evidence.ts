import type { BridgeRpcClientDiagnostic } from '../../mobile-web-shell/bridge/bridge-rpc-client'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import { checkpointListDifference, recordingDifferences } from '../rpc-recording/golden-difference'
import { RecordingParamsMismatch } from '../rpc-recording/recording-mismatch'
import type { Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import { captureValue } from '../rpc-recording/recording-values'
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
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.hasOwn(payload, '_meta')
  ) {
    return json
  }
  return JSON.stringify({
    ...frame,
    payload: { ...payload, _meta: { runtimeId: 'counterfactual-runtime' } }
  })
}

// Collect every differing field; proving all changes are ordinals requires more than the first difference.
export function divergingFields(expected: Recording, actual: Recording, complete = true): string[] {
  const list = checkpointListDifference(expected, actual)
  if (!complete && (list.missing.length || list.extra.length || list.reordered)) {
    return ['checkpoints']
  }
  return [
    ...(expected.scenario === actual.scenario ? [] : ['scenario']),
    ...(list.missing.length || list.extra.length || list.reordered ? ['checkpoints'] : []),
    ...recordingDifferences(expected, actual, complete).map(({ field, path }) => `${field}${path}`)
  ]
}

export function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sameParams(left: unknown, right: unknown): boolean {
  return JSON.stringify(captureValue(left)) === JSON.stringify(captureValue(right))
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

// Read the typed guard's own bound request and params; a message, rank or aggregate never stands in for it.
export function paramsMismatchEvidence(thrown: unknown): ParamsMismatchEvidence | null {
  if (!(thrown instanceof RecordingParamsMismatch)) {
    return null
  }
  return {
    step: thrown.request,
    undefinedValuedKeys: undefinedValuedPaths(thrown.expected),
    differingKeys: differingParamPaths(thrown.expected, thrown.actual)
  }
}
