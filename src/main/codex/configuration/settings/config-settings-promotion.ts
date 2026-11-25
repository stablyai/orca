import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import { resolvePromotionWriteTarget } from './config-settings-promotion-write-target'
import { ConcurrentFileEditError } from '../../../filesystem/concurrent-file-edit-guard'
import { writeTomlConfigAtomically } from '../toml/config-toml-atomic-write'
import {
  isWslSharePath,
  resolvesIntoWslShare
} from '../../../wsl/filesystem/wsl-share-path-resolution'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../homes/codex-home-paths'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  PROMOTED_STRUCTURED_KEYS,
  readPromotedSettingValues,
  readPromotedSettingValuesFromContent
} from '../toml/config-toml-promoted-setting-values'
import {
  observeCodexSettingsBaseline,
  writeCodexSettingsBaseline,
  type CodexSettingsConflict
} from './config-settings-baseline'
import { collectPromotionChanges } from './config-settings-promotion-changes'
import { extractOrdinaryCodexSettings } from '../toml/config-toml-runtime-owned-sections'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion,
  readCodexRegistrationBaseline
} from './config-plugin-registration-promotion'
import { hasCodexRegistrationEntries } from '../toml/config-toml-plugin-registration-tables'
import {
  EMPTY_GUEST_CARRY_FORWARD,
  type CodexGuestCarryForward,
  type CodexGuestRegeneration
} from './codex-config-guest-carry-forward'

export type CodexSettingsBaselineSnapshotOptions = {
  conflicts?: ReadonlyMap<string, CodexSettingsConflict>
  /** False for bootstrap baselines, which cannot establish canonical registration ownership. */
  mirroredRegistrations?: boolean
  /** Names copied from the canonical source in this mirror pass. */
  mirroredMcpServers?: ReadonlySet<string>
  mirroredMcpServerRoot?: boolean
  guestCarryForward?: CodexGuestCarryForward
  nativeSource?: boolean
}

/** Snapshot only after a successful mirror so pending runtime changes remain promotable. */
export function snapshotCodexRuntimeSettingsBaseline(
  runtimeHomePath = getOrcaManagedCodexHomePath(),
  options: CodexSettingsBaselineSnapshotOptions = {}
): boolean {
  try {
    const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
    // An empty baseline lets the first Codex write be detected and promoted.
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
        // Null distinguishes known absence from keys added by a later schema.
        settings.set(key, value?.raw ?? null)
      }
    }
    writeCodexSettingsBaseline(runtimeHomePath, {
      settings,
      conflicts,
      registrations: options.mirroredRegistrations
        ? readCodexRegistrationBaseline(runtimeConfig)
        : new Map(),
      mcpServers: options.mirroredMcpServers ?? new Set(),
      mcpServerRoot: options.mirroredMcpServerRoot ?? false,
      guestCarryForward: options.guestCarryForward,
      nativeSource: options.nativeSource
    })
    return true
  } catch (error) {
    console.warn('[codex-settings-promotion] failed to snapshot settings baseline', error)
    return false
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
  /** MCP names the previous mirror copied from the canonical source. */
  mirroredMcpServers: ReadonlySet<string>
  mirroredMcpServerRoot: boolean
  /** Set when a WSL distro config regenerates the managed copy; the mirror plans the carry from its own read. */
  guestRegeneration?: CodexGuestRegeneration
  /** The mirror replaces this with its plan; empty until then, which a starter baseline records. */
  guestCarryForward?: CodexGuestCarryForward
  /** A pass found ~/.codex outside any WSL distro; the baseline records it to skip that check later. */
  nativeSource?: boolean
}

function getHostPromotionHomes(): CodexSettingsPromotionHomes {
  return {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
}

/** Promote runtime edits before the mirror overwrites them; WSL callers supply per-distro homes. */
export function promoteCodexRuntimeSettingsToSystem(
  homes?: CodexSettingsPromotionHomes
): CodexSettingsPromotionPlan | null {
  const promotionHomes = homes ?? getHostPromotionHomes()
  try {
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      const plan = promoteCodexRuntimeSettingsToSystemUnsafe(promotionHomes)
      if (plan) {
        return plan
      }
    }
    throw new ConcurrentFileEditError(join(promotionHomes.systemHomePath, 'config.toml'))
  } catch (error) {
    // Failed promotion must not block Codex launch.
    console.warn('[codex-settings-promotion] failed to promote runtime settings', error)
    return null
  }
}

const PUBLISH_ATTEMPTS = 3

/** Null when the user saved the source config after Orca read it; the caller redoes the pass. */
function promoteCodexRuntimeSettingsToSystemUnsafe(
  homes: CodexSettingsPromotionHomes
): CodexSettingsPromotionPlan | null {
  const { runtimeHomePath, systemHomePath } = homes
  const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
  const systemTomlPath = join(systemHomePath, 'config.toml')
  if (resolve(runtimeTomlPath) === resolve(systemTomlPath)) {
    return emptyPromotionPlan()
  }
  // A drvfs source (a distro home under /mnt/c) is the distro's own config too.
  const sourceInGuest = homes.systemConfigDir !== undefined || isWslSharePath(systemTomlPath)
  const runtimeTomlObservation = observeAgentStateFile(runtimeTomlPath)
  if (runtimeTomlObservation.kind === 'indeterminate') {
    // Throw to stall the mirror rather than overwrite unreadable runtime changes.
    throw runtimeTomlObservation.error
  }
  if (sourceInGuest) {
    // A fresh guest copy has no tab edits of its own, but values kept earlier still apply.
    return regenerateFromGuestPlan(observeCodexSettingsBaseline(runtimeHomePath))
  }
  // Scalars need a baseline to distinguish stale copies from new Codex edits.
  const baselineObservation = observeCodexSettingsBaseline(runtimeHomePath)
  const knownNative =
    baselineObservation.kind === 'present' && baselineObservation.baseline.nativeSource === true
  // So is a host ~/.codex linked into a distro; resolved only when this pass can need it.
  const resolveHostSource = (): HostSource => {
    try {
      const target = resolvePromotionWriteTarget(systemTomlPath)
      return { writeTarget: target, guest: resolvesIntoWslShare(target.path) }
    } catch (error) {
      return { writeTarget: { error }, guest: false }
    }
  }
  if (runtimeTomlObservation.kind === 'absent') {
    if (knownNative) {
      return { ...emptyPromotionPlan(), nativeSource: true }
    }
    const hostSource = resolveHostSource()
    return hostSource.guest
      ? regenerateFromGuestPlan(baselineObservation)
      : { ...emptyPromotionPlan(), nativeSource: 'path' in hostSource.writeTarget }
  }
  if (baselineObservation.kind === 'indeterminate') {
    // An unreadable baseline cannot authorize mirroring over possible runtime edits.
    throw new Error('Codex settings baseline could not be read')
  }
  const baseline = baselineObservation.kind === 'present' ? baselineObservation.baseline : null
  const mirroredMcpServers = baseline?.mcpServers ?? new Set<string>()
  const mirroredMcpServerRoot = baseline?.mcpServerRoot ?? false
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
  // Registrations can promote before the first mirror because untracked tables are additions.
  const nothingToWrite =
    updates.size === 0 && !hasCodexRegistrationEntries(runtimeTomlObservation.value)
  const clean = nothingToWrite && conflicts.size === 0 && runtimeValuesToPreserve.size === 0
  if (clean && knownNative) {
    return {
      conflicts,
      runtimeValuesToPreserve,
      mirroredMcpServers,
      mirroredMcpServerRoot,
      nativeSource: true
    }
  }
  const { writeTarget, guest } = resolveHostSource()
  if (guest) {
    return regenerateFromGuestPlan(baselineObservation)
  }
  const resolved = 'path' in writeTarget
  if (clean) {
    return {
      conflicts,
      runtimeValuesToPreserve,
      mirroredMcpServers,
      mirroredMcpServerRoot,
      nativeSource: resolved
    }
  }
  // An unresolvable ~/.codex link could lead into a distro; stall rather than write through it.
  if (!resolved) {
    throw writeTarget.error
  }
  const plan = {
    conflicts,
    runtimeValuesToPreserve,
    mirroredMcpServers,
    mirroredMcpServerRoot,
    nativeSource: true
  }
  if (nothingToWrite) {
    return plan
  }
  // A new home may later hold auth.json, so create it owner-only.
  mkdirSync(systemHomePath, { recursive: true, mode: 0o700 })
  // Dangling dotfile links may target a parent directory that does not exist yet.
  mkdirSync(dirname(writeTarget.path), { recursive: true, mode: 0o700 })
  // Read the target before reconstructing it; registration promotion can run without a baseline.
  const writeTargetObservation = observeAgentStateFile(writeTarget.path)
  if (writeTargetObservation.kind === 'indeterminate') {
    throw writeTargetObservation.error
  }
  const targetExists = writeTargetObservation.kind === 'present'
  // Seed missing or blank sources with all ordinary runtime settings so the next mirror retains them.
  const systemContent =
    writeTargetObservation.kind === 'present' && writeTargetObservation.value.trim() !== ''
      ? writeTargetObservation.value
      : extractOrdinaryCodexSettings(runtimeTomlObservation.value)
  const withPromotedSettings = upsertPromotedSettingsInContent(systemContent, updates)
  // Plan against the seeded content to avoid appending registration tables already copied from runtime.
  const nextContent = applyCodexRegistrationPromotions(
    withPromotedSettings,
    planCodexRegistrationPromotion(
      runtimeTomlObservation.value,
      withPromotedSettings,
      baseline?.registrations ?? new Map()
    )
  )
  if (nextContent === systemContent) {
    return plan
  }
  const computedFrom = targetExists ? writeTargetObservation.value : null
  // Promotion never rotated the user's config.toml.bak; keep it that way.
  if (
    !writeTomlConfigAtomically(writeTarget.path, nextContent, computedFrom, {
      backup: false,
      refuseWslTarget: true
    })
  ) {
    return null
  }
  return plan
}

type HostSource = { writeTarget: { path: string } | { error: unknown }; guest: boolean }

/**
 * Orca never writes a WSL distro's own config, so nothing in the managed copy is kept back:
 * the mirror regenerates it from the distro file plus the lines the managed home owns.
 */
function regenerateFromGuestPlan(
  baselineObservation: ReturnType<typeof observeCodexSettingsBaseline>
): CodexSettingsPromotionPlan {
  if (baselineObservation.kind === 'indeterminate') {
    throw new Error('Codex settings baseline could not be read')
  }
  const baseline = baselineObservation.kind === 'present' ? baselineObservation.baseline : null
  return {
    ...emptyPromotionPlan(),
    mirroredMcpServers: baseline?.mcpServers ?? new Set(),
    mirroredMcpServerRoot: baseline?.mcpServerRoot ?? false,
    guestRegeneration: { baseline },
    // The mirror replans this from its own read; a pass that never reads a source keeps it as is.
    guestCarryForward: baseline?.guestCarryForward ?? EMPTY_GUEST_CARRY_FORWARD
  }
}

function emptyPromotionPlan(): CodexSettingsPromotionPlan {
  return {
    conflicts: new Map(),
    runtimeValuesToPreserve: new Map(),
    mirroredMcpServers: new Set(),
    mirroredMcpServerRoot: false
  }
}
