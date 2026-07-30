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

/** Builds the simctl arguments for a bounded Unified Log query. */
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
    options?.window ?? '1m'
  ]
  const predicate = buildSimulatorLogPredicate(options?.filters)
  if (predicate) {
    args.push('--predicate', predicate)
  }
  return args
}

/** Converts user filters into a safely escaped Unified Log predicate. */
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

/** Normalizes one simctl NDJSON record for the emulator logcat response. */
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function escapePredicateString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
