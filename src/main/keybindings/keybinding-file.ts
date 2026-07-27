/* eslint-disable max-lines -- Why: parsing, sanitizing, migrating, and writing the keybindings file must stay together so file-format edge cases share one validation path. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingDefinition,
  getKeybindingPlatform,
  isKeybindingActionId,
  normalizeKeybindingArrayForAction,
  normalizeKeybindingListForAction,
  type KeybindingActionId,
  type KeybindingFileDiagnostic,
  type KeybindingFileSnapshot,
  type KeybindingOverrides,
  type KeybindingPlatform
} from '../../shared/keybindings'

type JsonObject = Record<string, unknown>

const FILE_VERSION = 1
const PLATFORM_KEYS: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']
const ROOT_KEYS = new Set(['$schema', 'version', 'keybindings', 'platforms'])

export function getUserKeybindingsPath(homePath: string): string {
  return join(homePath, '.orca', 'keybindings.json')
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function createEmptyDocument(): JsonObject {
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

function readJsonDocument(path: string): {
  exists: boolean
  document: JsonObject | null
  error?: string
} {
  if (!existsSync(path)) {
    return { exists: false, document: createEmptyDocument() }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isJsonObject(parsed)) {
      return { exists: true, document: null, error: 'Keybindings file must contain a JSON object.' }
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

function writeJsonDocument(path: string, document: JsonObject): void {
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

function normalizeWriteBindingValue(actionId: KeybindingActionId, value: unknown): string[] | null {
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

function parseBindingSection(
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

function parsePlatformOverrides(
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

function removeConflictingOverrides(
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
        if (Object.prototype.hasOwnProperty.call(next, actionId)) {
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

export function readKeybindingFile(
  path: string,
  platform: NodeJS.Platform = process.platform
): KeybindingFileSnapshot {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const diagnostics: KeybindingFileDiagnostic[] = []
  const readResult = readJsonDocument(path)
  if (!readResult.document) {
    return {
      path,
      platform: keybindingPlatform,
      exists: readResult.exists,
      overrides: {},
      commonOverrides: {},
      platformOverrides: {},
      diagnostics: [
        {
          severity: 'error',
          message: `Could not read keybindings file: ${readResult.error ?? 'unknown error'}`
        }
      ]
    }
  }

  const document = readResult.document
  const commonOverrides =
    document.keybindings === undefined
      ? parseBindingSection(document, 'root', diagnostics, { skipRootKeys: true })
      : parseBindingSection(document.keybindings, 'keybindings', diagnostics)
  const platformOverrides = parsePlatformOverrides(document, diagnostics)
  const mergedOverrides = {
    ...commonOverrides,
    ...platformOverrides[keybindingPlatform]
  }
  const overrides = removeConflictingOverrides(keybindingPlatform, mergedOverrides, diagnostics)

  return {
    path,
    platform: keybindingPlatform,
    exists: readResult.exists,
    overrides,
    commonOverrides,
    platformOverrides,
    diagnostics
  }
}

export function ensureKeybindingFile(path: string): void {
  if (existsSync(path)) {
    return
  }
  writeJsonDocument(path, createEmptyDocument())
}

export function migrateLegacyKeybindings(
  path: string,
  platform: NodeJS.Platform,
  legacyOverrides: KeybindingOverrides | undefined
): void {
  if (existsSync(path) || !legacyOverrides || Object.keys(legacyOverrides).length === 0) {
    return
  }
  const keybindingPlatform = getKeybindingPlatform(platform)
  const document = createEmptyDocument()
  document.platforms = {
    darwin: {},
    linux: {},
    win32: {},
    [keybindingPlatform]: legacyOverrides
  }
  writeJsonDocument(path, document)
}

/**
 * Pin the pre-swap tab-switch chords for a pre-existing install so upgrading
 * users keep the shortcuts they learned. Writes into the active-platform
 * section (mirroring `writeKeybindingOverride`) so the seeded values stay
 * resettable from Settings.
 *
 * Pins per action, not all-or-nothing: an action is seeded only when this
 * platform has no effective override for it yet. That way a user who rebound
 * just one of the swapped actions keeps that choice AND keeps the pre-swap
 * default on the other three — an existing user's behavior is never altered,
 * whether they customized none, some, or all of them. Because every pin equals
 * the action's old default, the seeded set reproduces exactly today's effective
 * config and introduces no new conflicts.
 */
export function seedLegacyTabSwitchBindings(
  path: string,
  platform: NodeJS.Platform,
  legacyBindings: Readonly<Partial<Record<KeybindingActionId, string[]>>>
): { seeded: boolean; snapshot: KeybindingFileSnapshot } {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const actionIds = Object.keys(legacyBindings) as KeybindingActionId[]
  const current = readKeybindingFile(path, platform)
  const activePlatformOverrides = current.platformOverrides[keybindingPlatform] ?? {}
  // Why: the new defaults can temporarily make a valid pre-swap customization
  // look conflicting and remove it from `current.overrides`. Inspect the parsed
  // common + active-platform sections directly so the seed never replaces it.
  const toSeed = actionIds.filter(
    (actionId) =>
      !Object.prototype.hasOwnProperty.call(current.commonOverrides, actionId) &&
      !Object.prototype.hasOwnProperty.call(activePlatformOverrides, actionId)
  )
  if (toSeed.length === 0) {
    return { seeded: false, snapshot: current }
  }

  // Why: seed every pin that normalizes, but never freeze the one-shot if any
  // pin was dropped — throw after writing good pins so the cohort stays pending
  // and a fixed build retries the failed action without wiping the others.
  const pins: (readonly [KeybindingActionId, string[]])[] = []
  const failedActionIds: KeybindingActionId[] = []
  for (const actionId of toSeed) {
    const normalized = normalizeKeybindingArrayForAction(actionId, legacyBindings[actionId] ?? [])
    if (!Array.isArray(normalized)) {
      failedActionIds.push(actionId)
      continue
    }
    pins.push([actionId, normalized])
  }
  const snapshot =
    pins.length > 0
      ? writeActivePlatformSection(path, platform, current.commonOverrides, (activePlatform) => {
          for (const [actionId, normalized] of pins) {
            activePlatform[actionId] = normalized
          }
        })
      : current
  if (failedActionIds.length > 0) {
    throw new Error(`Could not normalize legacy binding for "${failedActionIds.join('", "')}".`)
  }
  return { seeded: pins.length > 0, snapshot }
}

// Why: the one-shot seed migration and Settings writes must produce the same
// on-disk document shape; a single assembly path keeps them from drifting.
function writeActivePlatformSection(
  path: string,
  platform: NodeJS.Platform,
  fallbackCommonOverrides: KeybindingOverrides,
  mutateActivePlatform: (activePlatform: JsonObject) => void
): KeybindingFileSnapshot {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const readResult = readJsonDocument(path)
  if (!readResult.document) {
    // Why: writes must never replace a user-owned file that could not be
    // parsed; callers surface the error (or retry the migration) after repair.
    throw new Error(readResult.error ?? 'Could not read keybindings file.')
  }
  const document = { ...readResult.document }
  const common = isJsonObject(document.keybindings)
    ? { ...document.keybindings }
    : { ...fallbackCommonOverrides }
  for (const rootKey of Object.keys(document)) {
    if (isKeybindingActionId(rootKey)) {
      delete document[rootKey]
    }
  }
  const platforms = isJsonObject(document.platforms) ? { ...document.platforms } : {}
  const activePlatform = isJsonObject(platforms[keybindingPlatform])
    ? { ...(platforms[keybindingPlatform] as JsonObject) }
    : {}
  mutateActivePlatform(activePlatform)

  document.version = FILE_VERSION
  document.keybindings = common
  document.platforms = {
    ...platforms,
    darwin: isJsonObject(platforms.darwin) ? platforms.darwin : {},
    linux: isJsonObject(platforms.linux) ? platforms.linux : {},
    win32: isJsonObject(platforms.win32) ? platforms.win32 : {},
    [keybindingPlatform]: activePlatform
  }
  writeJsonDocument(path, document)
  return readKeybindingFile(path, platform)
}

export function writeKeybindingOverride(
  path: string,
  platform: NodeJS.Platform,
  actionId: string,
  bindings: unknown
): KeybindingFileSnapshot {
  if (!isKeybindingActionId(actionId)) {
    throw new Error(`Unknown keybinding action "${actionId}".`)
  }
  const normalizedBindings = normalizeWriteBindingValue(actionId, bindings)

  const keybindingPlatform = getKeybindingPlatform(platform)
  const currentSnapshot = readKeybindingFile(path, platform)
  const candidateOverrides = { ...currentSnapshot.overrides }
  if (normalizedBindings === null) {
    delete candidateOverrides[actionId]
  } else {
    candidateOverrides[actionId] = normalizedBindings
  }
  const blockingConflict = findKeybindingConflicts(keybindingPlatform, candidateOverrides).find(
    (conflict) => conflict.actionIds.includes(actionId)
  )
  if (blockingConflict) {
    throw new Error(
      `${formatKeybindingList([blockingConflict.binding], keybindingPlatform)} conflicts with another shortcut.`
    )
  }

  return writeActivePlatformSection(
    path,
    platform,
    currentSnapshot.commonOverrides,
    (activePlatform) => {
      if (normalizedBindings === null) {
        // Why: Settings edits are scoped to the current platform. A hand-authored
        // common binding may be intentional for other OSes, so reset only removes
        // the platform-specific mask instead of deleting the shared value.
        delete activePlatform[actionId]
      } else {
        activePlatform[actionId] = normalizedBindings
      }
    }
  )
}
