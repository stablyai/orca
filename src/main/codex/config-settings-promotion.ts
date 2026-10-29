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

export type CodexSettingsBaselineSnapshotOptions = {
  conflicts?: ReadonlyMap<string, CodexSettingsConflict>
  /** False for bootstrap baselines, which cannot establish canonical registration ownership. */
  mirroredRegistrations?: boolean
  /** Names copied from the canonical source in this mirror pass. */
  mirroredMcpServers?: ReadonlySet<string>
  mirroredMcpServerRoot?: boolean
}

/** Snapshot only after a successful mirror so pending runtime changes remain promotable. */
export function snapshotCodexRuntimeSettingsBaseline(
  runtimeHomePath = getOrcaManagedCodexHomePath(),
  options: CodexSettingsBaselineSnapshotOptions = {}
): void {
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
      mcpServerRoot: options.mirroredMcpServerRoot ?? false
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
  /** MCP names the previous mirror copied from the canonical source. */
  mirroredMcpServers: ReadonlySet<string>
  mirroredMcpServerRoot: boolean
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
  try {
    return promoteCodexRuntimeSettingsToSystemUnsafe(homes ?? getHostPromotionHomes())
  } catch (error) {
    // Failed promotion must not block Codex launch.
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
    // Throw to stall the mirror rather than overwrite unreadable runtime changes.
    throw runtimeTomlObservation.error
  }
  // Scalars need a baseline to distinguish stale copies from new Codex edits.
  const baselineObservation = observeCodexSettingsBaseline(runtimeHomePath)
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
  if (updates.size === 0 && !hasCodexRegistrationEntries(runtimeTomlObservation.value)) {
    return { conflicts, runtimeValuesToPreserve, mirroredMcpServers, mirroredMcpServerRoot }
  }
  // A new home may later hold auth.json, so create it owner-only.
  mkdirSync(systemHomePath, { recursive: true, mode: 0o700 })
  const writeTarget = resolvePromotionWriteTarget(systemTomlPath)
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
    return { conflicts, runtimeValuesToPreserve, mirroredMcpServers, mirroredMcpServerRoot }
  }
  if (targetExists && parseWslUncPath(writeTarget.path)) {
    // WSL 9P symlink metadata is unreliable; write through to preserve the guest inode.
    writeFileSync(writeTarget.path, nextContent, 'utf-8')
    return { conflicts, runtimeValuesToPreserve, mirroredMcpServers, mirroredMcpServerRoot }
  }
  writeFileAtomically(writeTarget.path, nextContent, {
    mode: writeTarget.mode
  })
  return { conflicts, runtimeValuesToPreserve, mirroredMcpServers, mirroredMcpServerRoot }
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
        // Without an ancestor, preserve both values until a later edit resolves the conflict.
        context.conflicts.set(key, resolution.conflict)
        context.runtimeValuesToPreserve.set(key, runtimeRaw)
      }
      continue
    }

    if (runtimeRaw === null || runtimeRaw === context.baseline.settings.get(key)) {
      continue
    }
    // Canonical edits win when both sides changed from the known baseline.
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
  return {
    conflicts: new Map(),
    runtimeValuesToPreserve: new Map(),
    mirroredMcpServers: new Set(),
    mirroredMcpServerRoot: false
  }
}
