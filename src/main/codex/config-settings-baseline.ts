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
}

type StoredSettingsBaseline = {
  version: 1 | 2
  settings: Record<string, string | null>
  conflicts?: Record<string, CodexSettingsConflict>
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
    return { settings, conflicts }
  } catch (error) {
    // Why: invalid baseline state is still `null` — resetting it is the intent,
    // and only a read that FAILED must be preserved.
    return isDefinitiveAbsence(error) || isRebuildableBaselineError(error) ? null : 'unreadable'
  }
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
    version: 2,
    settings: Object.fromEntries(baseline.settings)
  }
  if (baseline.conflicts.size > 0) {
    file.conflicts = Object.fromEntries(baseline.conflicts)
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
    (candidate.version === 1 || candidate.version === 2) &&
    !!candidate.settings &&
    typeof candidate.settings === 'object' &&
    !Array.isArray(candidate.settings)
  )
}
