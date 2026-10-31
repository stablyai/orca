import { checkpointListDifference, recordingDifferences } from '../rpc-recording/golden-difference'
import type { Recording } from '../rpc-recording/recording-scenario'
import { captureValue } from '../rpc-recording/recording-values'

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
