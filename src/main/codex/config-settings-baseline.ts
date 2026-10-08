import { writeFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { JsonTextStructureCapacityError } from '../../shared/json-text-structure-limit'
import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
import { join } from 'node:path'
import { readAgentStateFileSync, readAgentStateJsonFileSync } from '../agent-state-file-reader'

const SETTINGS_BASELINE_FILE = '.orca-config-settings-baseline.json'

export type CodexSettingsConflict = {
  runtime: string | null
  system: string | null
}

export type CodexSettingsBaseline = {
  settings: ReadonlyMap<string, string | null>
  conflicts: ReadonlyMap<string, CodexSettingsConflict>
  /**
   * Plugin/marketplace tables the last mirror made canonical, with the fields a
   * three-way needs. An absent entry means "never mirrored", so a runtime-only
   * table reads as an addition rather than as a canonical removal.
   */
  registrations: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** MCP server names the last mirror copied from the canonical source. */
  mcpServers: ReadonlySet<string>
  mcpServerRoot: boolean
}

type StoredSettingsBaseline = {
  version: 1 | 2 | 3
  settings: Record<string, string | null>
  conflicts?: Record<string, CodexSettingsConflict>
  registrations?: Record<string, Record<string, string>>
  mcpServers?: string[]
  mcpServerRoot?: boolean
}

/**
 * Why callers need three answers, not two: without a readable baseline,
 * promotion cannot distinguish an in-Codex edit from Orca's last mirror. An
 * unreadable baseline must stall that mirror; absent and unparseable still map
 * to `absent` because rebuilding those is the intent.
 */
export type CodexSettingsBaselineObservation =
  | { kind: 'present'; baseline: CodexSettingsBaseline }
  | { kind: 'absent' }
  | { kind: 'indeterminate' }

export function observeCodexSettingsBaseline(
  runtimeHomePath: string
): CodexSettingsBaselineObservation {
  const baselinePath = getCodexSettingsBaselinePath(runtimeHomePath)
  const baseline = readParsedCodexSettingsBaseline(baselinePath)
  if (baseline === 'unreadable') {
    return { kind: 'indeterminate' }
  }
  return baseline ? { kind: 'present', baseline } : { kind: 'absent' }
}

/** Absent and unreadable both collapse to `null`; use the observation to tell them apart. */
export function readCodexSettingsBaseline(runtimeHomePath: string): CodexSettingsBaseline | null {
  const observation = observeCodexSettingsBaseline(runtimeHomePath)
  return observation.kind === 'present' ? observation.baseline : null
}

function readParsedCodexSettingsBaseline(
  baselinePath: string
): CodexSettingsBaseline | null | 'unreadable' {
  try {
    const parsed: unknown = readAgentStateJsonFileSync(baselinePath)
    if (!isStoredSettingsBaseline(parsed)) {
      return null
    }
    const settings = new Map(
      Object.entries(parsed.settings).filter((entry): entry is [string, string | null] => {
        return typeof entry[1] === 'string' || entry[1] === null
      })
    )
    const conflicts = new Map<string, CodexSettingsConflict>()
    for (const [key, conflict] of Object.entries(parsed.conflicts ?? {})) {
      if (
        conflict &&
        (typeof conflict.runtime === 'string' || conflict.runtime === null) &&
        (typeof conflict.system === 'string' || conflict.system === null)
      ) {
        conflicts.set(key, conflict)
      }
    }
    return {
      settings,
      conflicts,
      registrations: readStoredRegistrations(parsed.registrations),
      mcpServers: readStoredMcpServers(parsed.mcpServers),
      // Older mirrors owned the whole MCP root; retain that removal policy for one pass.
      mcpServerRoot: parsed.mcpServers === undefined || parsed.mcpServerRoot === true
    }
  } catch (error) {
    // Why: invalid baseline state is still `null` — resetting it is the intent,
    // and only a read that FAILED must be preserved.
    return isDefinitiveAbsence(error) || isRebuildableBaselineError(error) ? null : 'unreadable'
  }
}

function readStoredMcpServers(stored: string[] | undefined): ReadonlySet<string> {
  return new Set((stored ?? []).filter((name): name is string => typeof name === 'string'))
}

function readStoredRegistrations(
  stored: Record<string, Record<string, string>> | undefined
): Map<string, ReadonlyMap<string, string>> {
  const registrations = new Map<string, ReadonlyMap<string, string>>()
  for (const [key, fields] of Object.entries(stored ?? {})) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      continue
    }
    registrations.set(
      key,
      new Map(
        Object.entries(fields).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        })
      )
    )
  }
  return registrations
}

/** Why: known-present baseline state outside its parse/capacity contract is rebuildable, not unreadable. */
function isRebuildableBaselineError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof JsonTextStructureCapacityError ||
    error instanceof NodeFileReadTooLargeError
  )
}

export function writeCodexSettingsBaseline(
  runtimeHomePath: string,
  baseline: CodexSettingsBaseline
): void {
  const file: StoredSettingsBaseline = {
    version: 3,
    settings: Object.fromEntries(baseline.settings),
    mcpServers: [...baseline.mcpServers]
  }
  if (baseline.conflicts.size > 0) {
    file.conflicts = Object.fromEntries(baseline.conflicts)
  }
  if (baseline.registrations.size > 0) {
    file.registrations = Object.fromEntries(
      [...baseline.registrations].map(([key, fields]) => [key, Object.fromEntries(fields)])
    )
  }
  if (baseline.mcpServerRoot) {
    file.mcpServerRoot = true
  }
  const baselinePath = getCodexSettingsBaselinePath(runtimeHomePath)
  const serialized = `${JSON.stringify(file, null, 2)}\n`
  let existing: string | null = null
  try {
    existing = readAgentStateFileSync(baselinePath)
  } catch (error) {
    // Why: only absence or known-invalid derived state may authorize replacement.
    if (!isDefinitiveAbsence(error) && !isRebuildableBaselineError(error)) {
      throw error
    }
  }
  // Why: launch prep runs repeatedly; byte-identical baselines should not churn disk metadata.
  if (existing === serialized) {
    return
  }
  writeFileSync(baselinePath, serialized, { encoding: 'utf-8', mode: 0o600 })
}

export function getCodexSettingsBaselinePath(runtimeHomePath: string): string {
  return join(runtimeHomePath, SETTINGS_BASELINE_FILE)
}

function isStoredSettingsBaseline(value: unknown): value is StoredSettingsBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Partial<StoredSettingsBaseline>
  return (
    (candidate.version === 1 || candidate.version === 2 || candidate.version === 3) &&
    !!candidate.settings &&
    typeof candidate.settings === 'object' &&
    !Array.isArray(candidate.settings)
  )
}
