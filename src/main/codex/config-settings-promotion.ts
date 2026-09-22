import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { observeAgentStateFile } from './codex-path-observation'
import { resolvePromotionWriteTarget } from './config-settings-promotion-write-target'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  PROMOTED_STRUCTURED_KEYS,
  readPromotedSettingValues,
  readPromotedSettingValuesFromContent,
  type TopLevelSettingValue
} from './config-toml-promoted-setting-values'
import {
  observeCodexSettingsBaseline,
  writeCodexSettingsBaseline,
  type CodexSettingsBaseline,
  type CodexSettingsConflict
} from './config-settings-baseline'
import { resolveUntrackedCodexSetting } from './config-settings-conflict-resolution'
import { extractOrdinaryCodexSettings } from './config-toml-runtime-owned-sections'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion,
  readCodexRegistrationBaseline
} from './config-plugin-registration-promotion'
import { hasCodexRegistrationEntries } from './config-toml-plugin-registration-tables'

// Why: the mirror reverts in-Codex config changes each launch; promotion salvages them by diffing the last baseline.

export type CodexSettingsBaselineSnapshotOptions = {
  conflicts?: ReadonlyMap<string, CodexSettingsConflict>
  /**
   * Whether a mirror actually made the runtime's registration tables canonical.
   * A bootstrap baseline must leave this false: claiming tables Orca never
   * mirrored would read a source config that never had them as a removal.
   */
  mirroredRegistrations?: boolean
}

/**
 * Records the promotable settings the runtime config.toml holds after a mirror, so the next
 * promotion can tell "value Orca mirrored" from "value Codex wrote for the user".
 * Call after a successful mirror only — advancing past an unpromoted change strands it forever.
 */
export function snapshotCodexRuntimeSettingsBaseline(
  runtimeHomePath = getOrcaManagedCodexHomePath(),
  options: CodexSettingsBaselineSnapshotOptions = {}
): void {
  try {
    const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
    // Why: record an empty baseline even for a missing runtime config, so Codex's first write still diffs and promotes.
    const observation = observeAgentStateFile(runtimeTomlPath)
    if (observation.kind === 'indeterminate') {
      throw observation.error
    }
    const runtimeConfig = observation.kind === 'present' ? observation.value : ''
    const conflicts = options.conflicts ?? new Map<string, CodexSettingsConflict>()
    const runtimeValues = readPromotedSettingValuesFromContent(runtimeConfig)
    const settings = new Map<string, string | null>()
    for (const key of PROMOTED_STRUCTURED_KEYS) {
      const value = runtimeValues.get(key)
      if (!conflicts.has(key) && !value?.multiline) {
        // Why: explicit nulls distinguish a schema-aware absence from a key added by a later schema.
        settings.set(key, value?.raw ?? null)
      }
    }
    writeCodexSettingsBaseline(runtimeHomePath, {
      settings,
      conflicts,
      registrations: options.mirroredRegistrations
        ? readCodexRegistrationBaseline(runtimeConfig)
        : new Map()
    })
  } catch (error) {
    console.warn('[codex-settings-promotion] failed to snapshot settings baseline', error)
  }
}

export type CodexSettingsPromotionHomes = {
  runtimeHomePath: string
  systemHomePath: string
  /** Linux spelling of the source config directory when its host path is a drvfs drive. */
  systemConfigDir?: string
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
  // Why: without a baseline, a stale runtime scalar looks like a fresh in-Codex change; skip until the mirror writes one.
  const baselineObservation = observeCodexSettingsBaseline(runtimeHomePath)
  if (baselineObservation.kind === 'indeterminate') {
    // Why: an empty plan here lets the mirror proceed and write the system value
    // back over an in-Codex edit this baseline would have identified. The caller
    // turns a throw into the existing stall-and-retry null.
    throw new Error('Codex settings baseline could not be read')
  }
  const baseline = baselineObservation.kind === 'present' ? baselineObservation.baseline : null
  const updates = new Map<string, string>()
  const conflicts = new Map<string, CodexSettingsConflict>()
  const runtimeValuesToPreserve = new Map<string, string | null>()
  if (baseline) {
    collectPromotionChanges({
      baseline,
      runtimeValues: readPromotedSettingValues(runtimeTomlPath),
      systemValues: readPromotedSettingValues(systemTomlPath),
      updates,
      conflicts,
      runtimeValuesToPreserve
    })
  }
  // Why: registration tables reconcile against the mirrored-table baseline, which
  // is legitimately empty before the first mirror — a table Orca never made
  // canonical is an addition, never a removal it must honor. Scalars still need a
  // real baseline, so they stay gated above.
  if (updates.size === 0 && !hasCodexRegistrationEntries(runtimeTomlObservation.value)) {
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
  // With a baseline, this arm is a backstop — an unreadable system config
  // already refused in readPromotedSettingValues, because `writeTarget.path`
  // always resolves to the same file as `systemTomlPath` (its realpath, its
  // dangling-link target, or itself). Registration reconciliation runs without
  // a baseline and skips that read, so here it IS the live guard.
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
      : extractOrdinaryCodexSettings(runtimeTomlObservation.value)
  const withPromotedSettings = upsertPromotedSettingsInContent(systemContent, updates)
  // Why: plan against the content actually being edited, not a second read of the
  // source — when the system config is seeded from the runtime, its registration
  // tables are already present and re-appending them would duplicate the table.
  const nextContent = applyCodexRegistrationPromotions(
    withPromotedSettings,
    planCodexRegistrationPromotion(
      runtimeTomlObservation.value,
      withPromotedSettings,
      baseline?.registrations ?? new Map()
    )
  )
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
  runtimeValues: ReadonlyMap<string, TopLevelSettingValue>
  systemValues: ReadonlyMap<string, TopLevelSettingValue>
  updates: Map<string, string>
  conflicts: Map<string, CodexSettingsConflict>
  runtimeValuesToPreserve: Map<string, string | null>
}

function collectPromotionChanges(context: PromotionCollectionContext): void {
  for (const key of PROMOTED_STRUCTURED_KEYS) {
    const runtimeRaw = getComparableRaw(context.runtimeValues.get(key))
    const systemRaw = getComparableRaw(context.systemValues.get(key))
    if (runtimeRaw === undefined || systemRaw === undefined) {
      continue
    }

    const existingConflict = context.baseline.conflicts.get(key)
    if (existingConflict || !context.baseline.settings.has(key)) {
      const resolution = resolveUntrackedCodexSetting(runtimeRaw, systemRaw, existingConflict)
      if (resolution.action === 'promote-runtime') {
        context.updates.set(key, resolution.raw)
      } else if (resolution.action === 'preserve') {
        // Why: a schema-new key has no three-way ancestor; preserve both values until content changes one side.
        context.conflicts.set(key, resolution.conflict)
        context.runtimeValuesToPreserve.set(key, runtimeRaw)
      }
      continue
    }

    if (runtimeRaw === null || runtimeRaw === context.baseline.settings.get(key)) {
      continue
    }
    // Why: ~/.codex remains source of truth when both sides changed from a known baseline.
    if (systemRaw !== context.baseline.settings.get(key)) {
      continue
    }
    context.updates.set(key, runtimeRaw)
  }
}

function getComparableRaw(value: TopLevelSettingValue | undefined): string | null | undefined {
  if (!value) {
    return null
  }
  return value.multiline ? undefined : value.raw
}

function emptyPromotionPlan(): CodexSettingsPromotionPlan {
  return { conflicts: new Map(), runtimeValuesToPreserve: new Map() }
}

// Why: follow an existing dotfile-manager symlink and carry its mode forward so an atomic write can't widen a 0600 config.
