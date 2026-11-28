import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import { resolvePromotionWriteTarget } from './config-settings-promotion-write-target'
import { ConcurrentFileEditError } from '../../../filesystem/concurrent-file-edit-guard'
import { writeTomlConfigAtomically } from '../toml/config-toml-atomic-write'
import { resolvesIntoWslShare } from '../../../wsl/filesystem/wsl-share-path-resolution'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../homes/codex-home-paths'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  PROMOTED_STRUCTURED_KEYS,
  readPromotedSettingValues,
  readPromotedSettingValuesFromContent
} from '../toml/config-toml-promoted-setting-values'
import { recoverInterruptedGuardedFileOperation } from '../../../filesystem/atomic-file-publication'
import {
  getCodexSettingsBaselinePath,
  isGuestCarryForwardEmpty,
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
  isCodexNativeSourceCheckPending,
  startCodexNativeSourceCheck
} from './codex-native-source-check'
import { migrateGuestCarryForward } from './codex-config-guest-carry-forward'

export type CodexSettingsBaselineSnapshotOptions = {
  conflicts?: ReadonlyMap<string, CodexSettingsConflict>
  /** False for bootstrap baselines, which cannot establish canonical registration ownership. */
  mirroredRegistrations?: boolean
  /** Names copied from the canonical source in this mirror pass. */
  mirroredMcpServers?: ReadonlySet<string>
  mirroredMcpServerRoot?: boolean
  nativeSource?: boolean
  /** Source config whose native-source mark this pass trusted without resolving it. */
  confirmNativeSource?: string
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
      nativeSource: options.nativeSource
    })
    if (options.confirmNativeSource) {
      startCodexNativeSourceCheck(runtimeHomePath, options.confirmNativeSource)
    }
    return true
  } catch (error) {
    console.warn('[codex-settings-promotion] failed to snapshot settings baseline', error)
    return false
  }
}

export type CodexSettingsPromotionHomes = {
  runtimeHomePath: string
  systemHomePath: string
  /** A WSL distro's managed home, synced inside the distro; it receives no host resource links. */
  guestHome?: boolean
}

export type CodexSettingsPromotionPlan = {
  conflicts: ReadonlyMap<string, CodexSettingsConflict>
  runtimeValuesToPreserve: ReadonlyMap<string, string | null>
  /** MCP names the previous mirror copied from the canonical source. */
  mirroredMcpServers: ReadonlySet<string>
  mirroredMcpServerRoot: boolean
  /** A pass found ~/.codex outside any WSL distro; the baseline records it to skip that check later. */
  nativeSource?: boolean
  confirmNativeSource?: string
}

function getHostPromotionHomes(): CodexSettingsPromotionHomes {
  return {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
}

/** Promote runtime edits before the mirror overwrites them; the WSL helper supplies distro homes. */
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
  const runtimeTomlObservation = observeAgentStateFile(runtimeTomlPath)
  if (runtimeTomlObservation.kind === 'indeterminate') {
    // Throw to stall the mirror rather than overwrite unreadable runtime changes.
    throw runtimeTomlObservation.error
  }
  // Scalars need a baseline to distinguish stale copies from new Codex edits.
  let baselineObservation = observeCodexSettingsBaseline(runtimeHomePath)
  if (baselineObservation.kind === 'absent') {
    // Retiring the native mark swaps the baseline aside; a quit mid-swap must not read as no baseline.
    recoverInterruptedGuardedFileOperation(getCodexSettingsBaselinePath(runtimeHomePath))
    baselineObservation = observeCodexSettingsBaseline(runtimeHomePath)
  }
  const knownNative =
    baselineObservation.kind === 'present' &&
    baselineObservation.baseline.nativeSource === true &&
    !isCodexNativeSourceCheckPending(runtimeHomePath)
  // A host ~/.codex linked into a distro is that distro's file; resolved only when this pass can need it.
  const resolveHostSource = (): HostSource => {
    try {
      const target = resolvePromotionWriteTarget(systemTomlPath)
      return { writeTarget: target, guest: resolvesIntoWslShare(target.path) }
    } catch (error) {
      return { writeTarget: { error }, guest: false }
    }
  }
  // Without a trusted mark, resolve first so a guest source skips the native promotion reads.
  const hostSource = knownNative ? null : resolveHostSource()
  if (hostSource?.guest) {
    throw new CodexConfigLinkedIntoWslError(systemTomlPath)
  }
  if (runtimeTomlObservation.kind === 'absent') {
    return hostSource
      ? { ...emptyPromotionPlan(), nativeSource: 'path' in hostSource.writeTarget }
      : { ...emptyPromotionPlan(), nativeSource: true, confirmNativeSource: systemTomlPath }
  }
  if (baselineObservation.kind === 'indeterminate') {
    // An unreadable baseline cannot authorize mirroring over possible runtime edits.
    throw new Error('Codex settings baseline could not be read')
  }
  const baseline = baselineObservation.kind === 'present' ? baselineObservation.baseline : null
  if (baseline?.guestCarryForward && !isGuestCarryForwardEmpty(baseline.guestCarryForward)) {
    // Redo the pass on the files this just rewrote; the next one finds nothing left to carry.
    migrateGuestCarryForward(
      runtimeHomePath,
      runtimeTomlObservation.value,
      baseline,
      baseline.guestCarryForward
    )
    return null
  }
  const mirroredMcpServers = baseline?.mcpServers ?? new Set<string>()
  const mirroredMcpServerRoot = baseline?.mcpServerRoot ?? false
  const updates = new Map<string, string>()
  const conflicts = new Map<string, CodexSettingsConflict>()
  const runtimeValuesToPreserve = new Map<string, string | null>()
  let systemConfig = ''
  if (baseline) {
    const systemObservation = observeAgentStateFile(systemTomlPath)
    if (systemObservation.kind === 'indeterminate') {
      throw systemObservation.error
    }
    systemConfig = systemObservation.kind === 'present' ? systemObservation.value : ''
    collectPromotionChanges({
      baseline,
      runtimeValues: readPromotedSettingValues(runtimeTomlPath),
      systemValues: readPromotedSettingValuesFromContent(systemConfig),
      updates,
      conflicts,
      runtimeValuesToPreserve
    })
  }
  // Registrations can promote before the first mirror because untracked tables are additions.
  const nothingToWrite =
    updates.size === 0 &&
    (!hasCodexRegistrationEntries(runtimeTomlObservation.value) ||
      // A known native source's unchanged tables need no write, so no path lookup either.
      (knownNative &&
        systemConfig.trim() !== '' &&
        planCodexRegistrationPromotion(
          runtimeTomlObservation.value,
          systemConfig,
          baseline?.registrations ?? new Map()
        ).length === 0))
  const clean = nothingToWrite && conflicts.size === 0 && runtimeValuesToPreserve.size === 0
  const pending = { conflicts, runtimeValuesToPreserve, mirroredMcpServers, mirroredMcpServerRoot }
  if (clean && knownNative) {
    return { ...pending, nativeSource: true, confirmNativeSource: systemTomlPath }
  }
  const { writeTarget, guest } = hostSource ?? resolveHostSource()
  if (guest) {
    throw new CodexConfigLinkedIntoWslError(systemTomlPath)
  }
  const resolved = 'path' in writeTarget
  if (clean) {
    return { ...pending, nativeSource: resolved }
  }
  // An unresolvable ~/.codex link could lead into a distro; stall rather than write through it.
  if (!resolved) {
    throw writeTarget.error
  }
  const plan = { ...pending, nativeSource: true }
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
  // Defense in depth: never publish over \\wsl$, even if ~/.codex became a link into a distro
  // after the check above; the retry then finds the link and pauses the sync.
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

/** Stalls the pass: only a pass inside the distro may write a distro's file (never over \\wsl$). */
class CodexConfigLinkedIntoWslError extends Error {
  constructor(systemTomlPath: string) {
    super(
      `Codex settings sync paused: ${systemTomlPath} links into a WSL distro. Tab edits stay pending; edit that file in the distro or point ~/.codex at a Windows folder.`
    )
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
