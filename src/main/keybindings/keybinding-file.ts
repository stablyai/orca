import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
  normalizeKeybindingArrayForAction,
  splitBindingsByInputKind,
  splitOverridesByInputKind,
  unionKeybindingOverrides,
  unionPlatformKeybindingOverrides,
  type KeybindingActionId,
  type KeybindingFileDiagnostic,
  type KeybindingFileSnapshot,
  type KeybindingOverrides
} from '../../shared/keybindings'
import {
  createEmptyDocument,
  FILE_VERSION,
  isJsonObject,
  MOUSE_SECTION_KEY,
  normalizeWriteBindingValue,
  parseBindingSection,
  parseMouseSection,
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
  const keyboardCommon =
    document.keybindings === undefined
      ? parseBindingSection(document, 'root', diagnostics, { skipRootKeys: true })
      : parseBindingSection(document.keybindings, 'keybindings', diagnostics)
  const keyboardPlatforms = parsePlatformOverrides(document, diagnostics)
  const mouse = parseMouseSection(document, diagnostics)
  // Why: the two sections are one list per action to every reader above this
  // one; only the on-disk layout is split (see splitBindingsByInputKind).
  const commonOverrides = unionKeybindingOverrides(keyboardCommon, mouse.common)
  const platformOverrides = unionPlatformKeybindingOverrides(keyboardPlatforms, mouse.platforms)
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
      ? writeActivePlatformSection(path, platform, current.commonOverrides, (sections) => {
          for (const [actionId, normalized] of pins) {
            assignSplitBindings(sections, actionId, normalized)
          }
        })
      : current
  if (failedActionIds.length > 0) {
    throw new Error(`Could not normalize legacy binding for "${failedActionIds.join('", "')}".`)
  }
  return { seeded: pins.length > 0, snapshot }
}

/** The two active-platform sections a write may touch: keyboard bindings and mouse bindings. */
type ActiveBindingSections = { keyboard: JsonObject; mouse: JsonObject }

/** Routes an action's bindings to the section each kind is persisted in. */
function assignSplitBindings(
  sections: ActiveBindingSections,
  actionId: KeybindingActionId,
  bindings: readonly string[]
): void {
  const split = splitBindingsByInputKind(bindings)
  // Written even when empty: a mouse-only action must read as "no keyboard
  // shortcut" to a build that cannot parse the mouse one.
  sections.keyboard[actionId] = split.keyboard
  if (split.mouse.length > 0) {
    sections.mouse[actionId] = split.mouse
  } else {
    delete sections.mouse[actionId]
  }
}

// Why: keep the section out of the file entirely until a mouse binding exists,
// so an ordinary keybindings.json gains no new shape from this feature.
function buildMouseSection(common: JsonObject, platforms: JsonObject): JsonObject | null {
  const section: JsonObject = {}
  if (Object.keys(common).length > 0) {
    section.keybindings = common
  }
  const populatedPlatforms: JsonObject = {}
  for (const [platform, overrides] of Object.entries(platforms)) {
    if (isJsonObject(overrides) && Object.keys(overrides).length > 0) {
      populatedPlatforms[platform] = overrides
    }
  }
  if (Object.keys(populatedPlatforms).length > 0) {
    section.platforms = populatedPlatforms
  }
  return Object.keys(section).length > 0 ? section : null
}

// Why: the one-shot seed migration and Settings writes must produce the same
// on-disk document shape; a single assembly path keeps them from drifting.
function writeActivePlatformSection(
  path: string,
  platform: NodeJS.Platform,
  fallbackCommonOverrides: KeybindingOverrides,
  mutateActiveSections: (sections: ActiveBindingSections) => void
): KeybindingFileSnapshot {
  const keybindingPlatform = getKeybindingPlatform(platform)
  const readResult = readJsonDocument(path)
  if (!readResult.document) {
    // Why: writes must never replace a user-owned file that could not be
    // parsed; callers surface the error (or retry the migration) after repair.
    throw new Error(readResult.error ?? 'Could not read keybindings file.')
  }
  const document = { ...readResult.document }
  // The fallback is a merged snapshot view, so re-split it before it is written
  // back — a mouse binding must never land in the keyboard section.
  const fallbackCommon = splitOverridesByInputKind(fallbackCommonOverrides)
  const common = isJsonObject(document.keybindings)
    ? { ...document.keybindings }
    : { ...fallbackCommon.keyboard }
  for (const rootKey of Object.keys(document)) {
    if (isKeybindingActionId(rootKey)) {
      delete document[rootKey]
    }
  }
  const platforms = isJsonObject(document.platforms) ? { ...document.platforms } : {}
  const activePlatform = isJsonObject(platforms[keybindingPlatform])
    ? { ...(platforms[keybindingPlatform] as JsonObject) }
    : {}

  const storedMouseSection = document[MOUSE_SECTION_KEY]
  const mouseSection = isJsonObject(storedMouseSection) ? storedMouseSection : {}
  const mouseCommon = isJsonObject(mouseSection.keybindings)
    ? { ...mouseSection.keybindings }
    : { ...fallbackCommon.mouse }
  const mousePlatforms = isJsonObject(mouseSection.platforms) ? { ...mouseSection.platforms } : {}
  const storedMouseActivePlatform = mousePlatforms[keybindingPlatform]
  const mouseActivePlatform = isJsonObject(storedMouseActivePlatform)
    ? { ...storedMouseActivePlatform }
    : {}

  mutateActiveSections({ keyboard: activePlatform, mouse: mouseActivePlatform })

  document.version = FILE_VERSION
  document.keybindings = common
  document.platforms = {
    ...platforms,
    darwin: isJsonObject(platforms.darwin) ? platforms.darwin : {},
    linux: isJsonObject(platforms.linux) ? platforms.linux : {},
    win32: isJsonObject(platforms.win32) ? platforms.win32 : {},
    [keybindingPlatform]: activePlatform
  }
  const nextMouseSection = buildMouseSection(mouseCommon, {
    ...mousePlatforms,
    [keybindingPlatform]: mouseActivePlatform
  })
  if (nextMouseSection) {
    document[MOUSE_SECTION_KEY] = nextMouseSection
  } else {
    delete document[MOUSE_SECTION_KEY]
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

  return writeActivePlatformSection(path, platform, currentSnapshot.commonOverrides, (sections) => {
    if (normalizedBindings === null) {
      // Why: Settings edits are scoped to the current platform. A hand-authored
      // common binding may be intentional for other OSes, so reset only removes
      // the platform-specific mask instead of deleting the shared value.
      delete sections.keyboard[actionId]
      delete sections.mouse[actionId]
    } else {
      assignSplitBindings(sections, actionId, normalizedBindings)
    }
  })
}
