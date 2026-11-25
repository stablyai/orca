import type { ProviderRelayWorkMarker } from '../protocol/daemon-provider-relay-protocol'
import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import { mayHideKey } from './provider-relay-pending-requests'

/** More open tasks than this in one group reads as busy rather than growing without bound. */
const MAX_GROUP_TASKS = 1_024

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
    current = jsonProperty(current, part)
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

/** A keep-alive is a few dozen chars; a longer line is never transport-only. */
const QUIET_MAX_CHARS = 256

/** True for a short line whose top-level name is one of `names` (a transport-only line). */
export function isProviderRelayQuietLine(line: string, names: ReadonlySet<string>): boolean {
  if (names.size === 0 || line.length > QUIET_MAX_CHARS) {
    return false
  }
  const name = scannedName(line)
  return typeof name === 'string' && names.has(name)
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
    // Only a line its name can match is searched for values or escapes; others cost one scan.
    let escaped: boolean | undefined
    return this.needles.some(
      (marker) =>
        (scanned === undefined ? line.includes(marker.quoted) : marker.name === scanned) &&
        ((escaped ??= mayEscapeValue(line)) || marker.values.every((value) => line.includes(value)))
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
    const method = jsonProperty(value, 'method')
    const type = jsonProperty(value, 'type')
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
  /** Tasks that ended here, so the next app (which never saw them start) can restate and settle them. */
  private readonly ended = new Map<string, Set<string>>()
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

  /** The tasks that ended here, as key parts per group. */
  endedKeys(): Record<string, string[][]> | null {
    const ended: Record<string, string[][]> = {}
    for (const [group, tasks] of this.ended) {
      ended[group] = [...tasks].map((key) => key.split(KEY_SEPARATOR))
    }
    return this.ended.size > 0 ? ended : null
  }

  /** Work the daemon can't account for; the agent is never idle-stopped after it. */
  overflow(): void {
    this.overflowed = true
  }

  apply(change: ProviderRelayWorkChange): void {
    const tasks = this.groups.get(change.group) ?? new Set<string>()
    this.groups.set(change.group, tasks)
    const ended = this.ended.get(change.group) ?? new Set<string>()
    const end = (key: string): void => {
      tasks.delete(key)
      if (ended.size < MAX_GROUP_TASKS) {
        ended.add(key)
        this.ended.set(change.group, ended)
      }
    }
    if (change.effect === 'roster') {
      const next = new Set(change.keys)
      ;[...tasks].filter((key) => !next.has(key)).forEach(end)
      next.forEach((key) => tasks.add(key))
    } else if (change.effect === 'start') {
      tasks.add(change.key)
      ended.delete(change.key)
    } else {
      const under = change.key + KEY_SEPARATOR
      ;[...tasks].filter((key) => key === change.key || key.startsWith(under)).forEach(end)
    }
    if (tasks.size > MAX_GROUP_TASKS) {
      this.overflowed = true
    }
  }
}
