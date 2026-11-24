import type {
  ProviderRelayDetachPolicy,
  ProviderRelayWorkMarker
} from '../protocol/daemon-provider-relay-protocol'
import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import { mayHideKey } from './provider-relay-pending-requests'

const MAX_MARKERS = 16
const MAX_NAME_CHARS = 128
const MAX_PATH_DEPTH = 8
const MAX_KEY_PARTS = 4
const MAX_WHEN = 4
const MAX_OPEN_KEYS = 1_024
const MAX_KEY_CHARS = 512
/** More open tasks than this in one group reads as busy rather than growing without bound. */
const MAX_GROUP_TASKS = 1_024

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

function readMarker(value: unknown): ProviderRelayWorkMarker | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const marker = value as Record<string, unknown>
  const { group, name, effect, when, key, list } = marker
  const whenOk =
    when === undefined ||
    (Array.isArray(when) &&
      when.length <= MAX_WHEN &&
      when.every((test: unknown) => {
        const t = test as Record<string, unknown> | null
        return (
          typeof t === 'object' &&
          t !== null &&
          isPath(t.path) &&
          isName(t.is) &&
          (t.not === undefined || t.not === true)
        )
      }))
  if (
    !isName(group) ||
    !isName(name) ||
    (effect !== 'start' && effect !== 'end' && effect !== 'roster') ||
    !whenOk ||
    !isKey(key) ||
    (effect === 'roster' ? !isPath(list) : list !== undefined)
  ) {
    return null
  }
  return marker as ProviderRelayWorkMarker
}

function readOpen(value: unknown): Record<string, string[][]> | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  let count = 0
  for (const [group, keys] of Object.entries(value)) {
    if (!isName(group) || !Array.isArray(keys)) {
      return null
    }
    count += keys.length
    const ok = keys.every(
      (key: unknown) =>
        Array.isArray(key) &&
        key.length > 0 &&
        key.length <= MAX_KEY_PARTS &&
        key.every((part) => typeof part === 'string' && part.length <= MAX_KEY_CHARS)
    )
    if (!ok || count > MAX_OPEN_KEYS) {
      return null
    }
  }
  return value as Record<string, string[][]>
}

/** Untrusted wire input; anything malformed keeps today's behavior (the agent keeps running). */
export function readProviderRelayDetachPolicy(value: unknown): ProviderRelayDetachPolicy | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const policy = value as Record<string, unknown>
  const { idleStopMs } = policy
  const markers = Array.isArray(policy.markers) ? policy.markers.map(readMarker) : null
  const open = readOpen(policy.open)
  const { workRequests } = policy
  const requestsOk =
    workRequests === undefined ||
    (Array.isArray(workRequests) &&
      workRequests.length <= MAX_MARKERS &&
      workRequests.every(isName))
  if (
    !(idleStopMs === null || (typeof idleStopMs === 'number' && idleStopMs > 0)) ||
    !markers ||
    markers.length > MAX_MARKERS ||
    markers.some((marker) => marker === null) ||
    open === null ||
    !requestsOk
  ) {
    return null
  }
  return {
    idleStopMs: idleStopMs === null ? null : Math.min(idleStopMs, 2 ** 31 - 1),
    markers: markers as ProviderRelayWorkMarker[],
    ...(workRequests ? { workRequests: workRequests as string[] } : {}),
    ...(open ? { open } : {})
  }
}

/** One parsed marker line: a task opened or closed, or a group restated. */
export type ProviderRelayWorkChange =
  | { group: string; effect: 'start' | 'end'; key: string }
  | { group: string; effect: 'roster'; keys: string[] }

const KEY_SEPARATOR = '\u0000'
/** No marker names it, so nothing ends it: a chat that carries it never idle-stops. */
const UNACCOUNTED_GROUP = 'unaccounted-work'

export function providerRelayWorkKey(parts: readonly string[]): string {
  return parts.join(KEY_SEPARATOR)
}

function at(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function keyOf(value: unknown, key: readonly (readonly string[])[][]): string | null {
  const parts: string[] = []
  for (const alternatives of key) {
    const found = alternatives
      .map((path) => at(value, path))
      .find((part) => typeof part === 'string' || typeof part === 'number')
    if (found === undefined) {
      return null
    }
    parts.push(String(found))
  }
  return providerRelayWorkKey(parts)
}

/** The envelope scan reads at most this much of a line, and never walks into a payload. */
const ENVELOPE_SCAN_CHARS = 4096
const ENVELOPE_MAX_FIELDS = 32

/**
 * A line's top-level `method` (else `type`) from its leading envelope, without parsing it; undefined
 * when the scan couldn't decide (a field cut off, or the name after the payload).
 */
function scannedName(line: string): string | null | undefined {
  const { properties, complete } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
    stopAtContainer: true,
    maxFields: ENVELOPE_MAX_FIELDS
  })
  const named = (key: string) => properties.find((property) => property.key === key)?.value
  const name = named('method') ?? named('type')
  if (typeof name === 'string') {
    return name
  }
  return complete && !properties.some((p) => p.key === 'method' || p.key === 'type')
    ? null
    : undefined
}

/** A value spelled with escapes (`\/`, an escaped ASCII letter) can't be found as a substring. */
function mayEscapeValue(line: string): boolean {
  return line.includes('\\/') || mayHideKey(line)
}

/**
 * Reads agent lines against the app's markers. A line is parsed only when its scanned name is a
 * marker's and it contains every value that marker's `when` requires (so a busy notification like
 * a streaming update is parsed only when it can be the one that matters).
 */
export class ProviderRelayWorkReader {
  /** Per marker: its quoted name, and the quoted values its positive `when` tests need. */
  private readonly needles: { name: string; quoted: string; values: string[] }[]

  constructor(private readonly markers: readonly ProviderRelayWorkMarker[]) {
    this.needles = markers.map((marker) => ({
      name: marker.name,
      quoted: JSON.stringify(marker.name),
      values: (marker.when ?? []).filter((test) => !test.not).map((test) => JSON.stringify(test.is))
    }))
  }

  private mayMatch(line: string): boolean {
    const scanned = scannedName(line)
    if (scanned === null) {
      return false
    }
    const escaped = mayEscapeValue(line)
    return this.needles.some(
      (marker) =>
        (scanned === undefined ? line.includes(marker.quoted) : marker.name === scanned) &&
        (escaped || marker.values.every((value) => line.includes(value)))
    )
  }

  read(line: string): ProviderRelayWorkChange[] {
    if (!this.mayMatch(line)) {
      return []
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return []
    }
    if (typeof value !== 'object' || value === null) {
      return []
    }
    const { method, type } = value as { method?: unknown; type?: unknown }
    const name = typeof method === 'string' ? method : typeof type === 'string' ? type : null
    const changes: ProviderRelayWorkChange[] = []
    for (const marker of this.markers) {
      if (marker.name !== name || !(marker.when ?? []).every((test) => holds(value, test))) {
        continue
      }
      if (marker.effect === 'roster') {
        const tasks = at(value, marker.list ?? [])
        if (Array.isArray(tasks)) {
          const keys = tasks.flatMap((task) => keyOf(task, marker.key) ?? [])
          changes.push({ group: marker.group, effect: 'roster', keys })
        }
        continue
      }
      const key = keyOf(value, marker.key)
      if (key !== null) {
        changes.push({ group: marker.group, effect: marker.effect, key })
      }
    }
    return changes
  }
}

function holds(value: unknown, test: { path: string[]; is: string; not?: true }): boolean {
  return (at(value, test.path) === test.is) !== (test.not === true)
}

/** The open tasks, per group; busy while any is open or a group outgrew its bound. */
export class ProviderRelayOpenWork {
  private readonly groups = new Map<string, Set<string>>()
  private overflowed = false

  constructor(open: Record<string, string[][]>) {
    for (const [group, keys] of Object.entries(open)) {
      this.groups.set(group, new Set(keys.map(providerRelayWorkKey)))
    }
  }

  get busy(): boolean {
    return this.overflowed || [...this.groups.values()].some((tasks) => tasks.size > 0)
  }

  /** The open tasks as key parts per group; work it couldn't account for is one task of its own. */
  keys(): Record<string, string[][]> {
    const open: Record<string, string[][]> = {}
    for (const [group, tasks] of this.groups) {
      open[group] = [...tasks].map((key) => key.split(KEY_SEPARATOR))
    }
    if (this.overflowed) {
      open[UNACCOUNTED_GROUP] = [['unaccounted']]
    }
    return open
  }

  /** Work the daemon can't account for; the agent is never idle-stopped after it. */
  overflow(): void {
    this.overflowed = true
  }

  apply(change: ProviderRelayWorkChange): void {
    const tasks = this.groups.get(change.group) ?? new Set<string>()
    this.groups.set(change.group, tasks)
    if (change.effect === 'roster') {
      tasks.clear()
      change.keys.forEach((key) => tasks.add(key))
    } else if (change.effect === 'start') {
      tasks.add(change.key)
    } else {
      const under = change.key + KEY_SEPARATOR
      for (const key of tasks) {
        if (key === change.key || key.startsWith(under)) {
          tasks.delete(key)
        }
      }
    }
    if (tasks.size > MAX_GROUP_TASKS) {
      this.overflowed = true
    }
  }
}
