import { posix } from 'node:path'

export type SimulatorLogEntry = {
  timestamp?: string
  level?: string
  tag?: string
  message: string
}

type RawSimulatorLogEntry = {
  timestamp?: unknown
  messageType?: unknown
  subsystem?: unknown
  category?: unknown
  processImagePath?: unknown
  eventMessage?: unknown
}

/**
 * Builds the simctl arguments for a bounded Unified Log query.
 * @param udid Simulator device identifier.
 * @param options Query window and filter values.
 * @returns Arguments to pass directly to `xcrun`.
 */
export function simctlLogShowArgs(
  udid: string,
  options?: { window?: string; filters?: readonly string[] }
): string[] {
  const args = [
    'simctl',
    'spawn',
    udid,
    'log',
    'show',
    '--style',
    'ndjson',
    '--last',
    options?.window ?? '10m'
  ]
  const predicate = buildSimulatorLogPredicate(options?.filters)
  if (predicate) {
    args.push('--predicate', predicate)
  }
  return args
}

/**
 * Converts user filters into a safely escaped Unified Log predicate.
 * @param filters Case-insensitive values matched against application log fields.
 * @returns An NSPredicate expression, or `undefined` when no filters remain.
 */
export function buildSimulatorLogPredicate(filters?: readonly string[]): string | undefined {
  const values = filters?.map((filter) => filter.trim()).filter(Boolean)
  if (!values || values.length === 0) {
    return undefined
  }
  return values
    .map((filter) => {
      const value = escapePredicateString(filter)
      return (
        `(subsystem CONTAINS[c] "${value}" OR category CONTAINS[c] "${value}"` +
        ` OR process CONTAINS[c] "${value}" OR eventMessage CONTAINS[c] "${value}")`
      )
    })
    .join(' OR ')
}

/**
 * Normalizes one simctl NDJSON record for the emulator logcat response.
 * @param line One line emitted by `log show --style ndjson`.
 * @returns A normalized entry, or `undefined` for structural or malformed lines.
 */
export function parseSimulatorLogLine(line: string): SimulatorLogEntry | undefined {
  const trimmed = line.trim().replace(/,\s*$/, '')
  if (!trimmed || trimmed === '[' || trimmed === ']') {
    return undefined
  }
  let raw: RawSimulatorLogEntry
  try {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    raw = value as RawSimulatorLogEntry
  } catch {
    return undefined
  }

  const processPath = nonEmptyString(raw.processImagePath)
  const message = nonEmptyString(raw.eventMessage)
  if (!message) {
    return undefined
  }
  return {
    timestamp: nonEmptyString(raw.timestamp),
    level: nonEmptyString(raw.messageType),
    tag:
      nonEmptyString(raw.subsystem) ??
      nonEmptyString(raw.category) ??
      (processPath ? posix.basename(processPath) : undefined),
    message
  }
}

/**
 * Extracts non-empty strings from loosely typed Unified Log fields.
 * @param value Raw field value.
 * @returns The string value, or `undefined` when empty or non-string.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Escapes a literal before embedding it in an NSPredicate string.
 * @param value Untrusted filter value.
 * @returns Backslash- and quote-escaped predicate text.
 */
function escapePredicateString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
