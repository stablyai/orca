import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
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
      !Object.hasOwn(current.commonOverrides, actionId) &&
      !Object.hasOwn(activePlatformOverrides, actionId)
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
