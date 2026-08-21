import { existsSync, writeFileSync } from 'node:fs'
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

export function readCodexSettingsBaseline(runtimeHomePath: string): CodexSettingsBaseline | null {
  const baselinePath = getCodexSettingsBaselinePath(runtimeHomePath)
  if (!existsSync(baselinePath)) {
    return null
  }
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
  } catch {
    return null
  }
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
  // Why: launch prep runs repeatedly; byte-identical baselines should not churn disk metadata.
  if (existsSync(baselinePath) && readAgentStateFileSync(baselinePath) === serialized) {
    return
  }
  writeFileSync(baselinePath, serialized, { encoding: 'utf-8', mode: 0o600 })
}

function getCodexSettingsBaselinePath(runtimeHomePath: string): string {
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
