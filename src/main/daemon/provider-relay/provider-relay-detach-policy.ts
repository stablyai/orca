import type {
  ProviderRelayDetachPolicy,
  ProviderRelayWorkMarker
} from '../protocol/daemon-provider-relay-protocol'
import { jsonObject, jsonProperty } from '../../../shared/json-stream/json-value-property'

const MAX_MARKERS = 32
const MAX_NAME_CHARS = 128
const MAX_PATH_DEPTH = 8
const MAX_KEY_PARTS = 4
const MAX_WHEN = 4
const MAX_OPEN_KEYS = 1_024
const MAX_KEY_CHARS = 512

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_CHARS
}

function isPath(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length <= MAX_PATH_DEPTH && value.every((part) => isName(part))
  )
}

function isKey(value: unknown): value is string[][][] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_KEY_PARTS &&
    value.every(
      (part) => Array.isArray(part) && part.length > 0 && part.length <= 4 && part.every(isPath)
    )
  )
}

type WorkMarkerTest = NonNullable<ProviderRelayWorkMarker['when']>[number]

function readTest(value: unknown): WorkMarkerTest | null {
  const path = jsonProperty(value, 'path')
  const is = jsonProperty(value, 'is')
  const not = jsonProperty(value, 'not')
  if (!isPath(path) || !isName(is) || (not !== undefined && not !== true)) {
    return null
  }
  return not ? { path, is, not } : { path, is }
}

function readWhen(value: unknown): WorkMarkerTest[] | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_WHEN) {
    return null
  }
  const tests = value.map(readTest)
  return tests.every((test) => test !== null) ? tests : null
}

function isEffect(value: unknown): value is ProviderRelayWorkMarker['effect'] {
  return value === 'start' || value === 'end' || value === 'roster'
}

function readMarker(value: unknown): ProviderRelayWorkMarker | null {
  const marker = jsonObject(value)
  if (!marker) {
    return null
  }
  const { group, name, effect, key, list } = marker
  const when = readWhen(marker.when)
  if (!isName(group) || !isName(name) || !isEffect(effect) || when === null || !isKey(key)) {
    return null
  }
  const base = { group, name, effect, key, ...(when ? { when } : {}) }
  if (effect === 'roster') {
    return isPath(list) ? { ...base, list } : null
  }
  return list === undefined ? base : null
}

function isOpenKey(key: unknown): key is string[] {
  return (
    Array.isArray(key) &&
    key.length > 0 &&
    key.length <= MAX_KEY_PARTS &&
    key.every((part) => typeof part === 'string' && part.length <= MAX_KEY_CHARS)
  )
}

function readOpen(value: unknown): Record<string, string[][]> | null | undefined {
  if (value === undefined) {
    return undefined
  }
  const groups = jsonObject(value)
  if (!groups) {
    return null
  }
  const open: Record<string, string[][]> = {}
  let count = 0
  for (const [group, keys] of Object.entries(groups)) {
    if (!isName(group) || !Array.isArray(keys)) {
      return null
    }
    count += keys.length
    if (count > MAX_OPEN_KEYS || !keys.every(isOpenKey)) {
      return null
    }
    open[group] = keys
  }
  return open
}

/** Untrusted wire input; anything malformed keeps today's behavior (the agent keeps running). */
export function readProviderRelayDetachPolicy(value: unknown): ProviderRelayDetachPolicy | null {
  const policy = jsonObject(value)
  if (!policy) {
    return null
  }
  const { idleStopMs } = policy
  const markers = Array.isArray(policy.markers) ? policy.markers.map(readMarker) : null
  const open = readOpen(policy.open)
  const { workRequests, quiet, startApprovals } = policy
  const names = (value: unknown): value is string[] | undefined =>
    value === undefined ||
    (Array.isArray(value) && value.length <= MAX_MARKERS && value.every(isName))
  if (
    !(idleStopMs === null || (typeof idleStopMs === 'number' && idleStopMs > 0)) ||
    !markers ||
    markers.length > MAX_MARKERS ||
    !markers.every((marker): marker is ProviderRelayWorkMarker => marker !== null) ||
    open === null ||
    !names(workRequests) ||
    !names(quiet) ||
    !names(startApprovals)
  ) {
    return null
  }
  return {
    idleStopMs: idleStopMs === null ? null : Math.min(idleStopMs, 2 ** 31 - 1),
    markers,
    ...(workRequests ? { workRequests } : {}),
    ...(quiet ? { quiet } : {}),
    ...(startApprovals ? { startApprovals } : {}),
    ...(open ? { open } : {})
  }
}
