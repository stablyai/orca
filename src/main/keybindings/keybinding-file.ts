import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
  keybindingFileDiagnostic,
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

/** Pin each uncustomized action to its pre-swap chord in the active-platform section, preserving resettable user choices. */
export function seedLegacyTabSwitchBindings(
  path: string,
  platform: NodeJS.Platform,
  legacyBindings: Readonly<Partial<Record<KeybindingActionId, string[]>>>
): { seeded: boolean; snapshot: KeybindingFileSnapshot } {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const actionIds = Object.keys(legacyBindings) as KeybindingActionId[]
  const current = readKeybindingFile(path, platform)
  const activePlatformOverrides = current.platformOverrides[keybindingPlatform] ?? {}
  // New defaults can hide valid pre-swap overrides as conflicts; inspect raw common/platform sections.
  const toSeed = actionIds.filter(
    (actionId) =>
      !Object.hasOwn(current.commonOverrides, actionId) &&
      !Object.hasOwn(activePlatformOverrides, actionId)
  )
  if (toSeed.length === 0) {
    return { seeded: false, snapshot: current }
  }

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

// Migration and Settings writes must use the same document assembly.
function writeActivePlatformSection(
  path: string,
  platform: NodeJS.Platform,
  fallbackCommonOverrides: KeybindingOverrides,
  mutateActivePlatform: (activePlatform: JsonObject) => void
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
    }
  )
}
