import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  getKeybindingResetBindings,
  isKeybindingActionId,
  keybindingFileDiagnostic,
  resolveKeybindingOverrides,
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
  platform: NodeJS.Platform = process.platform,
  defaultOverrides: KeybindingOverrides = {},
  fallbackOverrides: KeybindingOverrides = {}
): KeybindingFileSnapshot {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const diagnostics: KeybindingFileDiagnostic[] = []
  const readResult = readJsonDocument(path)
  if (!readResult.document) {
    return {
      path,
      platform: keybindingPlatform,
      exists: readResult.exists,
      defaultOverrides,
      overrides: resolveKeybindingOverrides(platform, fallbackOverrides, defaultOverrides),
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
    ...fallbackOverrides,
    ...commonOverrides,
    ...platformOverrides[keybindingPlatform]
  }
  const overrides = removeConflictingOverrides(
    keybindingPlatform,
    resolveKeybindingOverrides(platform, mergedOverrides, defaultOverrides),
    diagnostics
  )

  return {
    path,
    platform: keybindingPlatform,
    exists: readResult.exists,
    overrides,
    defaultOverrides,
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
  if (!document) {
    throw new Error('Could not read keybindings file.')
  }
  const current = readKeybindingFile(path, platform)
  if (
    exists &&
    (!isJsonObject(document.migrations) ||
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

// Migration and Settings writes must use the same document assembly.
function writeActivePlatformSection(
  path: string,
  platform: NodeJS.Platform,
  fallbackCommonOverrides: KeybindingOverrides,
  mutateActivePlatform: (activePlatform: JsonObject) => void,
  defaultOverrides: KeybindingOverrides = {}
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
  document.migrations = {
    ...(isJsonObject(document.migrations) ? document.migrations : {}),
    legacySettings: 'done'
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
  return readKeybindingFile(path, platform, defaultOverrides)
}

export function writeKeybindingOverride(
  path: string,
  platform: NodeJS.Platform,
  actionId: string,
  bindings: unknown,
  defaultOverrides: KeybindingOverrides = {},
  fallbackOverrides: KeybindingOverrides = {}
): KeybindingFileSnapshot {
  if (!isKeybindingActionId(actionId)) {
    throw new Error(`Unknown keybinding action "${actionId}".`)
  }
  const keybindingPlatform = getKeybindingPlatform(platform)
  const currentSnapshot = readKeybindingFile(path, platform)
  const normalizedBindings =
    bindings === null
      ? getKeybindingResetBindings(actionId, platform, currentSnapshot.commonOverrides)
      : normalizeWriteBindingValue(actionId, bindings)
  const candidateOverrides = {
    ...fallbackOverrides,
    ...currentSnapshot.commonOverrides,
    ...currentSnapshot.platformOverrides[keybindingPlatform]
  }
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
  const blockingConflict = findKeybindingConflicts(
    keybindingPlatform,
    resolveKeybindingOverrides(platform, candidateOverrides, defaultOverrides),
    { includeMainProcessInterception: true }
  ).find((conflict) => conflict.actionIds.includes(actionId))
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
      for (const [fallbackAction, fallbackBindings] of Object.entries(fallbackOverrides)) {
        if (
          !Object.hasOwn(currentSnapshot.commonOverrides, fallbackAction) &&
          !Object.hasOwn(activePlatform, fallbackAction)
        ) {
          activePlatform[fallbackAction] = fallbackBindings
        }
      }
      if (normalizedBindings === null) {
        // Reset only the platform mask; common bindings may be intentional on other OSes.
        delete activePlatform[actionId]
      } else {
        activePlatform[actionId] = normalizedBindings
      }
    },
    defaultOverrides
  )
}
