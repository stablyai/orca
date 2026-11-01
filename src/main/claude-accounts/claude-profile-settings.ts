import { rmSync } from 'node:fs'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getManagedScriptFileName, removeManagedHooks } from '../claude/hook-settings'
import { readClaudeProfileObject } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import type { ClaudeProfileSurfaceOutcome } from './claude-profile-report'
import { copyClaudeProfileFile } from './claude-profile-sharing'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inheritedSettingsPath(target: string): string {
  return `${target}.orca-inherited.json`
}

function readInheritedModel(target: string): string | undefined {
  const read = readClaudeProfileObject(inheritedSettingsPath(target))
  if (read.kind === 'present' && typeof read.value.model === 'string') {
    return read.value.model
  }
  return undefined
}

function writeInheritedModel(target: string, model: string | undefined): void {
  const file = inheritedSettingsPath(target)
  if (model === undefined) {
    rmSync(file, { force: true })
    return
  }
  writeFileAtomically(file, Buffer.from(`${JSON.stringify({ model }, null, 2)}\n`, 'utf8'))
}

function hasProfileModelChoice(
  currentModel: unknown,
  inputModel: unknown,
  inheritedModel: string | undefined
): boolean {
  if (typeof currentModel !== 'string') {
    return false
  }
  if (inheritedModel !== undefined) {
    return currentModel !== inheritedModel
  }
  return inputModel === undefined || currentModel !== inputModel
}

// Ignore managed hooks and profile model/effort settings to avoid copy/install churn on every launch.
function settingsWithoutOrcaHooksOrModelSettings(
  value: Record<string, unknown>,
  ignoreModel: boolean
): string {
  const { config } = removeManagedHooks(value, getManagedScriptFileName())
  const rest = { ...config }
  delete rest.modelSettings
  delete rest.effortLevel
  if (ignoreModel) {
    delete rest.model
  }
  return JSON.stringify(rest)
}

function mergeProfileModelSettings(
  source: Record<string, unknown>,
  current: Record<string, unknown>,
  profileModelChoice: boolean
): Record<string, unknown> {
  const merged = { ...source }
  if (profileModelChoice && current.model !== undefined) {
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

function recordsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}

// Keep proxy addresses and credentials together in the settings copy, while preserving profile model/effort choices.
export function copySettings(source: string, target: string): ClaudeProfileSurfaceOutcome {
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const input = readClaudeProfileObject(source)
  const current = readClaudeProfileObject(target)
  const inheritedModel = readInheritedModel(target)

  const profileModelChoice =
    current.kind === 'present' &&
    hasProfileModelChoice(
      current.value.model,
      input.kind === 'present' ? input.value.model : undefined,
      inheritedModel
    )

  // Compare values because hook installation changes serialization and profile model choices persist.
  // When the profile has no model choice, compare the model as well so global updates propagate.
  if (
    input.kind === 'present' &&
    current.kind === 'present' &&
    settingsWithoutOrcaHooksOrModelSettings(input.value, profileModelChoice) ===
      settingsWithoutOrcaHooksOrModelSettings(current.value, profileModelChoice)
  ) {
    if (inheritedModel === undefined && typeof input.value.model === 'string') {
      writeInheritedModel(target, input.value.model)
    }
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
      const merged = mergeProfileModelSettings(parsedSource, current.value, profileModelChoice)
      return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    } catch {
      return sourceText
    }
  }

  const outcome = copyClaudeProfileFile(source, target, render)
  if (outcome === 'synced') {
    if (input.kind === 'present' && typeof input.value.model === 'string') {
      writeInheritedModel(target, input.value.model)
    } else {
      writeInheritedModel(target, undefined)
    }
  } else if (outcome === 'unchanged') {
    if (
      inheritedModel === undefined &&
      input.kind === 'present' &&
      typeof input.value.model === 'string'
    ) {
      writeInheritedModel(target, input.value.model)
    }
  }

  if (outcome === 'absent' && lstatIfPresent(target)?.isFile()) {
    const preserved: Record<string, unknown> = {}
    if (current.kind === 'present') {
      if (profileModelChoice && current.value.model !== undefined) {
        preserved.model = current.value.model
      }
      if (current.value.modelSettings !== undefined) {
        preserved.modelSettings = current.value.modelSettings
      }
      if (current.value.effortLevel !== undefined) {
        preserved.effortLevel = current.value.effortLevel
      }
    }
    if (Object.keys(preserved).length === 0) {
      rmSync(target, { force: true })
      writeInheritedModel(target, undefined)
      return 'synced'
    }
    if (current.kind === 'present' && recordsEqual(current.value, preserved)) {
      return 'unchanged'
    }
    writeFileAtomically(target, Buffer.from(`${JSON.stringify(preserved, null, 2)}\n`, 'utf8'))
    writeInheritedModel(target, undefined)
    return 'synced'
  }

  return outcome
}
