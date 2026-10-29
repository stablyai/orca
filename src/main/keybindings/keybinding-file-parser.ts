import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  findKeybindingConflicts,
  getKeybindingDefinition,
  isKeybindingActionId,
  keybindingFileDiagnostic,
  keybindingValidationFailure,
  KEYBINDING_REASON_COPY,
  normalizeKeybindingArrayForAction,
  normalizeKeybindingListForAction,
  type KeybindingActionId,
  type KeybindingFileDiagnostic,
  type KeybindingOverrides,
  type KeybindingPlatform,
  type KeybindingReasonCode,
  type KeybindingValidationResult
} from '../../shared/keybindings'

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

export function readJsonDocument(path: string): {
  exists: boolean
  document: JsonObject | null
  error?: string
  errorCode?: KeybindingReasonCode
} {
  if (!existsSync(path)) {
    return { exists: false, document: createEmptyDocument() }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isJsonObject(parsed)) {
      return {
        exists: true,
        document: null,
        error: KEYBINDING_REASON_COPY.fileNotObject,
        errorCode: 'fileNotObject'
      }
    }
    return { exists: true, document: parsed }
  } catch (error) {
    return {
      exists: true,
      document: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function writeJsonDocument(path: string, document: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(tempPath, path)
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath)
      }
    } catch {
      // Ignore cleanup failure; the original write error is more actionable.
    }
    throw error
  }
}

function normalizeBindingValue(
  actionId: KeybindingActionId,
  value: unknown
): { ok: true; value: string[] } | Extract<KeybindingValidationResult, { ok: false }> {
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
      return keybindingValidationFailure('invalidBindingValue')
    }
    const normalized = normalizeKeybindingArrayForAction(actionId, value)
    return Array.isArray(normalized)
      ? { ok: true, value: normalized }
      : normalized.ok
        ? { ok: true, value: [normalized.value] }
        : normalized
  }
  return keybindingValidationFailure('invalidBindingValue')
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
    diagnostics.push(
      keybindingFileDiagnostic({ severity: 'error', section }, 'sectionNotObject', { section })
    )
    return {}
  }

  const overrides: KeybindingOverrides = {}
  for (const [actionId, rawBinding] of Object.entries(value)) {
    if (options.skipRootKeys && ROOT_KEYS.has(actionId)) {
      continue
    }
    if (!isKeybindingActionId(actionId)) {
      diagnostics.push(
        keybindingFileDiagnostic({ severity: 'warning', section, actionId }, 'unknownAction', {
          actionId
        })
      )
      continue
    }
    const normalized = normalizeBindingValue(actionId, rawBinding)
    if (!normalized.ok) {
      diagnostics.push(
        keybindingFileDiagnostic(
          { severity: 'error', section, actionId },
          'shortcutIgnored',
          { actionId, reason: normalized.error },
          normalized.errorCode
        )
      )
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
    diagnostics.push(
      keybindingFileDiagnostic({ severity: 'error', section: 'platforms' }, 'platformsNotObject')
    )
    return {}
  }

  const result: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const [platform, value] of Object.entries(rawPlatforms)) {
    if (!PLATFORM_KEYS.includes(platform as KeybindingPlatform)) {
      diagnostics.push(
        keybindingFileDiagnostic(
          { severity: 'warning', section: `platforms.${platform}` },
          'unknownPlatform',
          { platform }
        )
      )
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

    next = { ...next }
    for (const actionId of conflictingOverrides) {
      delete next[actionId]
    }

    diagnostics.push(
      keybindingFileDiagnostic(
        { severity: 'error', actionIds: Array.from(conflictingOverrides) },
        'conflictingOverrides',
        {
          actions: Array.from(conflictingOverrides)
            .map((actionId) => getKeybindingDefinition(actionId)?.title ?? actionId)
            .join(', ')
        }
      )
    )
  }
  return next
}
