import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { observeAgentStateFile } from './codex-path-observation'
import { resolvePromotionWriteTarget } from './config-settings-promotion-write-target'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import { removePromotedSettingsFromContent } from './codex-config-settings-removal'
import {
  observeCodexSettingsBaseline,
  writeCodexSettingsBaseline,
  type CodexSettingsBaseline,
  type CodexSettingsConflict
} from './config-settings-baseline'
import {
  resolveUnlistedCodexSetting,
  resolveUntrackedCodexSetting
} from './config-settings-conflict-resolution'
import {
  collectOrdinaryCodexSettingKeys,
  isOrdinarySettingBlocked,
  isPromotedStructuredKey,
  parseOrdinaryCodexSettingValues,
  PROMOTED_STRUCTURED_KEYS,
  type OrdinaryCodexSettingValue
} from './config-toml-ordinary-settings'
import { extractOrdinaryCodexSettings } from './config-toml-runtime-owned-sections'

// Why: the mirror reverts in-Codex config changes each launch; promotion salvages them by diffing the last baseline.

function readOrdinarySettingValues(configPath: string): Map<string, OrdinaryCodexSettingValue> {
  // Why: an unreadable config held no settings only in the sense that we could
  // not read them. Returning an empty map says the user cleared every promoted
  // value, and the write below then acts on that.
  const observation = observeAgentStateFile(configPath)
  if (observation.kind === 'absent') {
    return new Map()
  }
  if (observation.kind === 'indeterminate') {
    throw observation.error
  }
  return parseOrdinaryCodexSettingValues(observation.value)
}

/**
 * Records supported ordinary settings after a mirror so the next pass can identify runtime edits.
 * Call after a successful mirror only — advancing past an unpromoted change strands it forever.
 */
export function snapshotCodexRuntimeSettingsBaseline(
  runtimeHomePath = getOrcaManagedCodexHomePath(),
  conflicts: ReadonlyMap<string, CodexSettingsConflict> = new Map(),
  options: { sourceIsAuthoritative?: boolean } = {}
): void {
  try {
    const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
    // Why: record an empty baseline even for a missing runtime config, so Codex's first write still diffs and promotes.
    const runtimeValues = readOrdinarySettingValues(runtimeTomlPath)
    const settings = new Map<string, string | null>()
    const sourceIsAuthoritative = options.sourceIsAuthoritative ?? true
    const keys = sourceIsAuthoritative ? runtimeValues.keys() : PROMOTED_STRUCTURED_KEYS
    for (const key of keys) {
      const value = runtimeValues.get(key)
      if (!conflicts.has(key) && !value?.multiline && !value?.unsupported) {
        // Why: explicit nulls distinguish a schema-aware absence from a key added by a later schema.
        settings.set(key, value?.raw ?? null)
      }
    }
    for (const key of PROMOTED_STRUCTURED_KEYS) {
      if (!conflicts.has(key) && !settings.has(key)) {
        const value = runtimeValues.get(key)
        if (!value?.multiline && !value?.unsupported) {
          settings.set(key, value?.raw ?? null)
        }
      }
    }
    writeCodexSettingsBaseline(runtimeHomePath, {
      settings,
      conflicts,
      knownPromotedKeys: new Set(PROMOTED_STRUCTURED_KEYS),
      sourceIsAuthoritative,
      tracksAllOrdinarySettings: sourceIsAuthoritative
    })
  } catch (error) {
    console.warn('[codex-settings-promotion] failed to snapshot settings baseline', error)
  }
}

export type CodexSettingsPromotionHomes = {
  runtimeHomePath: string
  systemHomePath: string
}

export type CodexSettingsPromotionPlan = {
  conflicts: ReadonlyMap<string, CodexSettingsConflict>
  runtimeValuesToPreserve: ReadonlyMap<string, string | null>
}

function getHostPromotionHomes(): CodexSettingsPromotionHomes {
  return {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
}

/**
 * Promotes in-Codex setting changes from the runtime config.toml into ~/.codex/config.toml.
 * Runs before the config mirror so promoted values survive it instead of reverting.
 * WSL callers pass explicit per-distro homes; default is the host runtime home and ~/.codex.
 */
export function promoteCodexRuntimeSettingsToSystem(
  homes?: CodexSettingsPromotionHomes
): CodexSettingsPromotionPlan | null {
  try {
    return promoteCodexRuntimeSettingsToSystemUnsafe(homes ?? getHostPromotionHomes())
  } catch (error) {
    // Why: promotion is best-effort launch prep; a malformed file must not block Codex launch.
    console.warn('[codex-settings-promotion] failed to promote runtime settings', error)
    return null
  }
}

function promoteCodexRuntimeSettingsToSystemUnsafe(
  homes: CodexSettingsPromotionHomes
): CodexSettingsPromotionPlan {
  const { runtimeHomePath, systemHomePath } = homes
  const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
  const systemTomlPath = join(systemHomePath, 'config.toml')
  if (resolve(runtimeTomlPath) === resolve(systemTomlPath)) {
    return emptyPromotionPlan()
  }
  const runtimeTomlObservation = observeAgentStateFile(runtimeTomlPath)
  if (runtimeTomlObservation.kind === 'absent') {
    return emptyPromotionPlan()
  }
  if (runtimeTomlObservation.kind === 'indeterminate') {
    // Why: the caller turns a throw into the existing "stall and retry" null. An
    // empty plan here would instead let the mirror proceed against a runtime
    // config nobody read.
    throw runtimeTomlObservation.error
  }
  // Why: without a baseline, a stale runtime value looks like a fresh in-Codex change; skip until the mirror writes one.
  const baselineObservation = observeCodexSettingsBaseline(runtimeHomePath)
  if (baselineObservation.kind === 'indeterminate') {
    // Why: an empty plan here lets the mirror proceed and write the system value
    // back over an in-Codex edit this baseline would have identified. The caller
    // turns a throw into the existing stall-and-retry null.
    throw new Error('Codex settings baseline could not be read')
  }
  if (baselineObservation.kind === 'absent') {
    return emptyPromotionPlan()
  }
  const baseline = baselineObservation.baseline
  const runtimeValues = readOrdinarySettingValues(runtimeTomlPath)
  const systemTomlObservation = observeAgentStateFile(systemTomlPath)
  if (systemTomlObservation.kind === 'indeterminate') {
    throw systemTomlObservation.error
  }
  const systemSourceIsBlank =
    systemTomlObservation.kind === 'present' && systemTomlObservation.value.trim() === ''
  if (
    baseline.sourceIsAuthoritative &&
    (systemTomlObservation.kind === 'absent' || systemSourceIsBlank)
  ) {
    throw new Error('Authoritative Codex config source is unavailable')
  }
  if (systemSourceIsBlank) {
    return emptyPromotionPlan()
  }
  const systemValues =
    systemTomlObservation.kind === 'present'
      ? parseOrdinaryCodexSettingValues(systemTomlObservation.value)
      : new Map<string, OrdinaryCodexSettingValue>()
  const updates = new Map<string, string>()
  const conflicts = new Map<string, CodexSettingsConflict>()
  const runtimeValuesToPreserve = new Map<string, string | null>()
  collectPromotionChanges({
    baseline,
    runtimeValues,
    systemValues,
    updates,
    conflicts,
    runtimeValuesToPreserve
  })
  if (updates.size === 0) {
    return { conflicts, runtimeValuesToPreserve }
  }
  // Why: a fresh host has no ~/.codex; create it owner-only (holds auth.json) or the atomic write ENOENTs and the mirror wipes it.
  mkdirSync(systemHomePath, { recursive: true, mode: 0o700 })
  const writeTarget = resolvePromotionWriteTarget(systemTomlPath)
  // Why: a dangling symlink may target an unmade dir tree; create its real parent so the atomic temp write has a home.
  mkdirSync(dirname(writeTarget.path), { recursive: true, mode: 0o700 })
  // Why: this is the user's real ~/.codex/config.toml, and an indeterminate
  // existence probe sent it down the reconstruct branch below, which replaces
  // the canonical config with settings derived from Orca's runtime copy. One
  // read replaces the old existsSync + read pair and its TOCTOU gap.
  // The indeterminate arm is a backstop rather than the live guard: an
  // unreadable system config already refused above,
  // because `writeTarget.path` always resolves to the same file as
  // `systemTomlPath` (its realpath, its dangling-link target, or itself).
  const writeTargetObservation = observeAgentStateFile(writeTarget.path)
  if (writeTargetObservation.kind === 'indeterminate') {
    throw writeTargetObservation.error
  }
  const targetExists = writeTargetObservation.kind === 'present'
  // Why: seeding a brand-new ~/.codex/config.toml from the promoted keys alone
  // would leave a skeleton the next mirror treats as authoritative, deleting
  // every other runtime setting (mcp_servers, features). With no system config
  // the runtime IS the user's config, so carry its ordinary settings across.
  const systemContent =
    writeTargetObservation.kind === 'present'
      ? writeTargetObservation.value
      : getMissingSystemSeedContent(runtimeTomlObservation.value, runtimeValues)
  const nextContent = upsertPromotedSettingsInContent(systemContent, updates)
  if (nextContent === systemContent) {
    return { conflicts, runtimeValuesToPreserve }
  }
  if (targetExists && parseWslUncPath(writeTarget.path)) {
    // Why: \\wsl$ 9P symlink metadata is unreliable; write through the existing file to preserve the WSL-side inode.
    writeFileSync(writeTarget.path, nextContent, 'utf-8')
    return { conflicts, runtimeValuesToPreserve }
  }
  writeFileAtomically(writeTarget.path, nextContent, {
    mode: writeTarget.mode
  })
  return { conflicts, runtimeValuesToPreserve }
}

type PromotionCollectionContext = {
  baseline: CodexSettingsBaseline
  runtimeValues: ReadonlyMap<string, OrdinaryCodexSettingValue>
  systemValues: ReadonlyMap<string, OrdinaryCodexSettingValue>
  updates: Map<string, string>
  conflicts: Map<string, CodexSettingsConflict>
  runtimeValuesToPreserve: Map<string, string | null>
}

function collectPromotionChanges(context: PromotionCollectionContext): void {
  for (const key of collectOrdinaryCodexSettingKeys(context.runtimeValues, context.systemValues, [
    ...context.baseline.settings.keys(),
    ...context.baseline.conflicts.keys()
  ])) {
    if (
      isOrdinarySettingBlocked(context.runtimeValues, key) ||
      isOrdinarySettingBlocked(context.systemValues, key)
    ) {
      continue
    }
    const runtimeRaw = getComparableRaw(context.runtimeValues.get(key))
    const systemRaw = getComparableRaw(context.systemValues.get(key))
    if (runtimeRaw === undefined || systemRaw === undefined) {
      continue
    }

    const existingConflict = context.baseline.conflicts.get(key)
    const promoted = isPromotedStructuredKey(key)
    const tracked = isTrackedSetting(context.baseline, key, promoted)
    if (existingConflict || !tracked) {
      const resolution = promoted
        ? resolveUntrackedCodexSetting(runtimeRaw, systemRaw, existingConflict)
        : resolveUnlistedCodexSetting(runtimeRaw, systemRaw, existingConflict)
      if (resolution.action === 'promote-runtime') {
        if (promoted) {
          context.updates.set(key, resolution.raw)
        }
      } else if (resolution.action === 'preserve') {
        // Why: a schema-new key has no three-way ancestor; preserve both values until content changes one side.
        context.conflicts.set(key, resolution.conflict)
        context.runtimeValuesToPreserve.set(key, runtimeRaw)
      }
      continue
    }

    const ancestor = context.baseline.settings.get(key) ?? null
    if (runtimeRaw === ancestor) {
      continue
    }
    if (systemRaw !== ancestor) {
      if (!promoted && runtimeRaw !== systemRaw) {
        preserveLocalValue(context, key, runtimeRaw, systemRaw)
      }
      continue
    }
    if (promoted) {
      if (runtimeRaw !== null) {
        context.updates.set(key, runtimeRaw)
      }
    } else {
      preserveLocalValue(context, key, runtimeRaw, systemRaw)
    }
  }
}

function isTrackedSetting(
  baseline: CodexSettingsBaseline,
  key: string,
  promoted: boolean
): boolean {
  if (promoted && baseline.tracksAllOrdinarySettings && !baseline.knownPromotedKeys.has(key)) {
    return false
  }
  return baseline.settings.has(key) || (baseline.tracksAllOrdinarySettings && !promoted)
}

function preserveLocalValue(
  context: PromotionCollectionContext,
  key: string,
  runtime: string | null,
  system: string | null
): void {
  context.conflicts.set(key, { runtime, system })
  context.runtimeValuesToPreserve.set(key, runtime)
}

function getMissingSystemSeedContent(
  runtimeContent: string,
  runtimeValues: ReadonlyMap<string, OrdinaryCodexSettingValue>
): string {
  const localOnlyKeys = new Set<string>()
  for (const [key, value] of runtimeValues) {
    if (!isPromotedStructuredKey(key) && !value.multiline && !value.unsupported) {
      localOnlyKeys.add(key)
    }
  }
  return removePromotedSettingsFromContent(
    extractOrdinaryCodexSettings(runtimeContent),
    localOnlyKeys
  )
}

function getComparableRaw(value: OrdinaryCodexSettingValue | undefined): string | null | undefined {
  if (!value) {
    return null
  }
  return value.multiline || value.unsupported ? undefined : value.raw
}

function emptyPromotionPlan(): CodexSettingsPromotionPlan {
  return { conflicts: new Map(), runtimeValuesToPreserve: new Map() }
}

// Why: follow an existing dotfile-manager symlink and carry its mode forward so an atomic write can't widen a 0600 config.
