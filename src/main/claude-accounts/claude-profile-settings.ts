import { rmSync } from 'node:fs'
import { getManagedScriptFileName, removeManagedHooks } from '../claude/hook-settings'
import { readClaudeProfileObject } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import type { ClaudeProfileSurfaceOutcome } from './claude-profile-report'
import { copyClaudeProfileFile } from './claude-profile-sharing'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Ignore managed hooks and profile model/effort settings to avoid copy/install churn on every launch.
function settingsWithoutOrcaHooksOrModelSettings(value: Record<string, unknown>): string {
  const { config } = removeManagedHooks(value, getManagedScriptFileName())
  const rest = { ...config }
  delete rest.modelSettings
  delete rest.effortLevel
  delete rest.model
  return JSON.stringify(rest)
}

function hasProfileOwnedChoices(value: Record<string, unknown>): boolean {
  return (
    value.model !== undefined ||
    value.modelSettings !== undefined ||
    value.effortLevel !== undefined
  )
}

function mergeProfileModelSettings(
  source: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...source }
  if (current.model !== undefined) {
    merged.model = current.model
  }
  if (current.modelSettings !== undefined) {
    merged.modelSettings =
      isPlainRecord(source.modelSettings) && isPlainRecord(current.modelSettings)
        ? { ...source.modelSettings, ...current.modelSettings }
        : current.modelSettings
  }
  if (current.effortLevel !== undefined) {
    merged.effortLevel = current.effortLevel
  }
  return merged
}

// Keep proxy addresses and credentials together in the settings copy, while preserving profile model/effort choices.
export function copySettings(source: string, target: string): ClaudeProfileSurfaceOutcome {
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const input = readClaudeProfileObject(source)
  const current = readClaudeProfileObject(target)
  // Compare values because hook installation changes serialization and profile model choices persist.
  if (
    input.kind === 'present' &&
    current.kind === 'present' &&
    settingsWithoutOrcaHooksOrModelSettings(input.value) ===
      settingsWithoutOrcaHooksOrModelSettings(current.value)
  ) {
    return 'unchanged'
  }
  const render = (sourceText: Buffer): Buffer => {
    if (current.kind !== 'present') {
      return sourceText
    }
    try {
      const parsedSource = JSON.parse(sourceText.toString('utf8'))
      if (!isPlainRecord(parsedSource)) {
        return sourceText
      }
      const merged = mergeProfileModelSettings(parsedSource, current.value)
      return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    } catch {
      return sourceText
    }
  }
  const outcome = copyClaudeProfileFile(source, target, render)
  if (outcome === 'absent' && lstatIfPresent(target)?.isFile()) {
    if (current.kind === 'present' && hasProfileOwnedChoices(current.value)) {
      return 'unchanged'
    }
    rmSync(target, { force: true })
    return 'synced'
  }
  return outcome
}
