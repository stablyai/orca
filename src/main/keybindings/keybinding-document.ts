import { getKeybindingDefinition, isKeybindingActionId } from '../../shared/keybindings/definitions'
import { findKeybindingConflicts } from '../../shared/keybindings/formatting'
import {
  normalizeKeybindingArrayForAction,
  normalizeKeybindingListForAction
} from '../../shared/keybindings/normalization'
import type {
  KeybindingActionId,
  KeybindingFileDiagnostic,
  KeybindingOverrides,
  KeybindingPlatform
} from '../../shared/keybindings/types'

export type JsonObject = Record<string, unknown>

export const FILE_VERSION = 1
const PLATFORM_KEYS: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']
const ROOT_KEYS = new Set(['$schema', 'version', 'keybindings', 'platforms'])

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function createEmptyDocument(): JsonObject {
  return {
    version: FILE_VERSION,
    keybindings: {},
    platforms: {
      darwin: {},
      linux: {},
      win32: {}
    }
  }
}

function normalizeBindingValue(
  actionId: KeybindingActionId,
  value: unknown
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === null || value === false) {
    return { ok: true, value: [] }
  }
  if (typeof value === 'string') {
    const normalized = normalizeKeybindingListForAction(actionId, value)
    return Array.isArray(normalized)
      ? { ok: true, value: normalized }
      : normalized.ok
        ? { ok: true, value: [normalized.value] }
        : normalized
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) {
      return { ok: false, error: 'Use a string, string array, null, or false.' }
    }
    const normalized = normalizeKeybindingArrayForAction(actionId, value)
    return Array.isArray(normalized)
      ? { ok: true, value: normalized }
      : normalized.ok
        ? { ok: true, value: [normalized.value] }
        : normalized
  }
  return { ok: false, error: 'Use a string, string array, null, or false.' }
}

export function normalizeWriteBindingValue(
  actionId: KeybindingActionId,
  value: unknown
): string[] | null {
  if (value === null) {
    return null
  }
  if (!Array.isArray(value) || !value.every((binding) => typeof binding === 'string')) {
    throw new Error('Use a string array or null.')
  }
  const normalized = normalizeKeybindingArrayForAction(actionId, value)
  if (!Array.isArray(normalized)) {
    throw new Error(normalized.ok ? 'Unable to parse shortcut.' : normalized.error)
  }
  return normalized
}

export function parseBindingSection(
  value: unknown,
  section: string,
  diagnostics: KeybindingFileDiagnostic[],
  options: { skipRootKeys?: boolean } = {}
): KeybindingOverrides {
  if (value === undefined) {
    return {}
  }
  if (!isJsonObject(value)) {
    diagnostics.push({
      severity: 'error',
      section,
      message: `${section} must be an object.`
    })
    return {}
  }

  const overrides: KeybindingOverrides = {}
  for (const [actionId, rawBinding] of Object.entries(value)) {
    if (options.skipRootKeys && ROOT_KEYS.has(actionId)) {
      continue
    }
    if (!isKeybindingActionId(actionId)) {
      diagnostics.push({
        severity: 'warning',
        section,
        actionId,
        message: `Unknown keybinding action "${actionId}" was ignored.`
      })
      continue
    }
    const normalized = normalizeBindingValue(actionId, rawBinding)
    if (!normalized.ok) {
      diagnostics.push({
        severity: 'error',
        section,
        actionId,
        message: `Shortcut for "${actionId}" was ignored: ${normalized.error}`
      })
      continue
    }
    overrides[actionId] = normalized.value
  }
  return overrides
}

export function parsePlatformOverrides(
  document: JsonObject,
  diagnostics: KeybindingFileDiagnostic[]
): Partial<Record<KeybindingPlatform, KeybindingOverrides>> {
  const rawPlatforms = document.platforms
  if (rawPlatforms === undefined) {
    return {}
  }
  if (!isJsonObject(rawPlatforms)) {
    diagnostics.push({
      severity: 'error',
      section: 'platforms',
      message: 'platforms must be an object with darwin, linux, or win32 sections.'
    })
    return {}
  }

  const result: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const [platform, value] of Object.entries(rawPlatforms)) {
    if (!PLATFORM_KEYS.includes(platform as KeybindingPlatform)) {
      diagnostics.push({
        severity: 'warning',
        section: `platforms.${platform}`,
        message: `Unknown platform "${platform}" was ignored.`
      })
      continue
    }
    result[platform as KeybindingPlatform] = parseBindingSection(
      value,
      `platforms.${platform}`,
      diagnostics
    )
  }
  return result
}

export function removeConflictingOverrides(
  platform: KeybindingPlatform,
  overrides: KeybindingOverrides,
  diagnostics: KeybindingFileDiagnostic[]
): KeybindingOverrides {
  let next = { ...overrides }
  for (let attempt = 0; attempt < 20; attempt++) {
    const conflicts = findKeybindingConflicts(platform, next)
    const conflictingOverrides = new Set<KeybindingActionId>()

    for (const conflict of conflicts) {
      for (const actionId of conflict.actionIds) {
        if (Object.hasOwn(next, actionId)) {
          conflictingOverrides.add(actionId)
        }
      }
    }

    if (conflictingOverrides.size === 0) {
      return next
    }

    for (const actionId of conflictingOverrides) {
      delete next[actionId]
    }

    diagnostics.push({
      severity: 'error',
      message: `Conflicting custom shortcuts were ignored: ${Array.from(conflictingOverrides)
        .map((actionId) => getKeybindingDefinition(actionId)?.title ?? actionId)
        .join(', ')}.`
    })
  }
  return next
}
