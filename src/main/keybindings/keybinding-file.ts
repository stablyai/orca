import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
  keybindingFileDiagnostic,
  LEGACY_MAC_SEARCH_BINDINGS,
  LEGACY_TAB_SWITCH_BINDINGS,
  normalizeKeybindingArrayForAction,
  type KeybindingActionId,
  type KeybindingFileDiagnostic,
  type KeybindingFileSnapshot,
  type KeybindingOverrides
} from '../../shared/keybindings'
import {
  createEmptyDocument,
  FILE_VERSION,
  isJsonObject,
  normalizeWriteBindingValue,
  parseBindingSection,
  parsePlatformOverrides,
  readJsonDocument,
  removeConflictingOverrides,
  writeJsonDocument,
  type JsonObject
} from './keybinding-file-parser'

export function getUserKeybindingsPath(homePath: string): string {
  return join(homePath, '.orca', 'keybindings.json')
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
        keybindingFileDiagnostic(
          { severity: 'error' },
          'readFailed',
          { reason: readResult.error ?? 'unknown error' },
          readResult.errorCode
        )
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
  if (!legacyOverrides || Object.keys(legacyOverrides).length === 0) {
    return
  }
  const { document, exists } = readJsonDocument(path)
  const current = readKeybindingFile(path, platform)
  if (
    exists &&
    (!isJsonObject(document?.migrations) ||
      document.migrations.legacySettings !== 'pending' ||
      current.diagnostics.length > 0 ||
      Object.keys(current.commonOverrides).length > 0 ||
      Object.values(current.platformOverrides).some((bindings) => Object.keys(bindings).length > 0))
  ) {
    return
  }
  writeActivePlatformSection(path, platform, current.commonOverrides, (activePlatform) => {
    Object.assign(activePlatform, legacyOverrides)
  })
}

/** Pin each uncustomized action to its pre-swap chord in the active-platform section, preserving resettable user choices. */
export function seedLegacyKeybindings(
  path: string,
  platform: NodeJS.Platform,
  legacyBindings: Readonly<Partial<Record<KeybindingActionId, string[]>>>,
  migration: 'tab-switch' | 'search'
): { seeded: boolean; snapshot: KeybindingFileSnapshot } {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const readResult = readJsonDocument(path)
  if (!readResult.document) {
    throw new Error(readResult.error ?? 'Could not read keybindings file.')
  }
  const doc = readResult.document
  if (
    (doc.keybindings !== undefined && !isJsonObject(doc.keybindings)) ||
    (doc.platforms !== undefined &&
      (!isJsonObject(doc.platforms) ||
        ['darwin', 'linux', 'win32'].some(
          (key) =>
            doc.platforms &&
            isJsonObject(doc.platforms) &&
            doc.platforms[key] !== undefined &&
            !isJsonObject(doc.platforms[key])
        )))
  ) {
    throw new Error('Cannot migrate malformed keybinding sections.')
  }
  const migrations = isJsonObject(readResult.document.migrations)
    ? readResult.document.migrations
    : {}
  const platformMigrations = isJsonObject(migrations[keybindingPlatform])
    ? migrations[keybindingPlatform]
    : {}
  const actionIds = Object.keys(legacyBindings) as KeybindingActionId[]
  const current = readKeybindingFile(path, platform)
  // Profiles share this file; a later profile must not undo another profile's reset.
  if (platformMigrations[migration] === true) {
    return { seeded: false, snapshot: current }
  }
  const activePlatformOverrides = current.platformOverrides[keybindingPlatform] ?? {}
  // New defaults can hide valid pre-swap overrides as conflicts; inspect raw common/platform sections.
  const toSeed = actionIds.filter(
    (actionId) =>
      !Object.hasOwn(current.commonOverrides, actionId) &&
      !Object.hasOwn(activePlatformOverrides, actionId)
  )
  // Write valid pins, then throw on dropped pins so a fixed build can retry the pending cohort.
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
    pins.length > 0 || failedActionIds.length === 0
      ? writeActivePlatformSection(
          path,
          platform,
          current.commonOverrides,
          (activePlatform, document) => {
            for (const [actionId, normalized] of pins) {
              activePlatform[actionId] = normalized
            }
            if (failedActionIds.length === 0) {
              document.migrations = {
                ...migrations,
                ...(!readResult.exists ? { legacySettings: 'pending' } : {}),
                ...(pins.length > 0 ? { legacySettings: 'done' } : {}),
                [keybindingPlatform]: { ...platformMigrations, [migration]: true }
              }
            }
          },
          'migration'
        )
      : current
  if (failedActionIds.length > 0) {
    throw new Error(`Could not normalize legacy binding for "${failedActionIds.join('", "')}".`)
  }
  return { seeded: pins.length > 0, snapshot }
}

// Migration and Settings writes must use the same document assembly.
function writeActivePlatformSection(
  path: string,
  platform: NodeJS.Platform,
  fallbackCommonOverrides: KeybindingOverrides,
  mutateActivePlatform: (activePlatform: JsonObject, document: JsonObject) => void,
  source: 'migration' | 'settings' = 'settings',
  resetMigration?: 'tab-switch' | 'search'
): KeybindingFileSnapshot {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const readResult = readJsonDocument(path)
  if (!readResult.document) {
    // Never overwrite an unreadable user-owned file; callers surface or retry the error.
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
  mutateActivePlatform(activePlatform, document)
  // A deliberate reset is authoritative even when it leaves every binding section empty.
  if (source === 'settings') {
    const migrations = isJsonObject(document.migrations) ? document.migrations : {}
    const platformMigrations = isJsonObject(migrations[keybindingPlatform])
      ? migrations[keybindingPlatform]
      : {}
    document.migrations = {
      ...migrations,
      legacySettings: 'done',
      ...(resetMigration
        ? { [keybindingPlatform]: { ...platformMigrations, [resetMigration]: true } }
        : {})
    }
  }

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
    const common = currentSnapshot.commonOverrides[actionId]
    if (common) {
      candidateOverrides[actionId] = common
    } else {
      delete candidateOverrides[actionId]
    }
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
        // Reset only the platform mask; common bindings may be intentional on other OSes.
        delete activePlatform[actionId]
      } else {
        activePlatform[actionId] = normalizedBindings
      }
    },
    'settings',
    normalizedBindings === null
      ? Object.hasOwn(LEGACY_TAB_SWITCH_BINDINGS, actionId)
        ? 'tab-switch'
        : Object.hasOwn(LEGACY_MAC_SEARCH_BINDINGS, actionId)
          ? 'search'
          : undefined
      : undefined
  )
}
