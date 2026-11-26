import { readMcpServerTomlOwnership } from '../toml/config-toml-mcp-servers'
import { join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import {
  recoverInterruptedGuardedFileOperation,
  writeFileAtomicallyIfUnchanged
} from '../../../filesystem/atomic-file-publication'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../homes/codex-home-paths'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline,
  type CodexSettingsPromotionHomes,
  type CodexSettingsPromotionPlan
} from './config-settings-promotion'
import { observeCodexSettingsBaseline, readCodexSettingsBaseline } from './config-settings-baseline'
import { getCodexConfigSyncStatus, reportCodexConfigSyncOutcome } from './config-sync-stall'
import { preserveRuntimeConflictValues } from './codex-config-settings-preservation'
import {
  applyMeasuredRuntimeOwnedConfig,
  applyRuntimeOwnedConfig
} from './codex-config-runtime-owned-values'
import { codexDaemonSocketPathExceedsLimit } from '../shared-server/codex-daemon-socket-path-guard'
import {
  guardSystemConfigForRuntimeMerge,
  prepareSystemConfigForFreshRuntimeMirror,
  prepareSystemConfigForRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror-source'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'

// Mirrored MCP environment tokens require owner-only writes.
const RUNTIME_CONFIG_WRITE = { mode: 0o600 } as const

export function syncSystemConfigIntoManagedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): boolean {
  const result = mirrorSystemConfigIntoManagedCodexHome(homes)
  if (!result.ran) {
    // Apply the daemon guard even on mirror stalls so long home paths can still launch Codex.
    ensureCodexDaemonSocketGuard(homes.runtimeHomePath)
  }
  return result.complete
}

/** A baseline failure prevents reuse without changing when the daemon guard is owed. */
function mirrorSystemConfigIntoManagedCodexHome(homes: CodexSettingsPromotionHomes): {
  ran: boolean
  complete: boolean
} {
  // Promote in-chat changes before mirroring ~/.codex or this pass would revert them.
  const promotionPlan = promoteCodexRuntimeSettingsToSystem(homes)
  if (!promotionPlan) {
    // Preserve runtime/baseline for retry; promotion failures must report stalls without clearing the latch.
    const stalledStatus = getCodexConfigSyncStatus(homes)
    if (stalledStatus.state === 'stalled') {
      reportCodexConfigSyncOutcome(homes.runtimeHomePath, stalledStatus)
    }
    return { ran: false, complete: false }
  }
  let mirrorResult: CodexConfigMirrorResult
  try {
    mirrorResult = syncSystemConfigIntoManagedCodexHomeUnsafe(homes, promotionPlan)
  } catch (error) {
    // Latch mirror failures too, so the user sees their cause without repeated generic logging.
    reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes), error)
    return { ran: false, complete: false }
  }
  if (mirrorResult.status === 'refused-indeterminate') {
    // Keep the baseline unchanged on indeterminate reads so unmirrored changes can retry.
    reportCodexConfigSyncOutcome(
      homes.runtimeHomePath,
      getCodexConfigSyncStatus(homes),
      mirrorResult.error
    )
    return { ran: false, complete: false }
  }
  if (mirrorResult.status === 'superseded') {
    // Keep the baseline: it must describe a config this pass published. The guard is still owed.
    return { ran: false, complete: false }
  }
  reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes))
  if (mirrorResult.status === 'skipped-missing-source') {
    // Bootstrap seeded homes only; advancing an existing baseline would strand unmirrored changes.
    const seeded = !readCodexSettingsBaseline(homes.runtimeHomePath)
    const complete =
      !seeded || snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath, promotionPlan)
    return { ran: true, complete }
  }
  // Advance the baseline only after mirroring so unpromoted changes remain eligible for retry.
  const complete = snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath, {
    ...promotionPlan,
    conflicts: new Map(
      [...promotionPlan.conflicts].filter(([key]) => mirrorResult.preservedConflictKeys.has(key))
    ),
    // Missing marketplace/plugin tables in later source configs now count as removals.
    mirroredRegistrations: true,
    mirroredMcpServers: mirrorResult.mirroredMcpServerNames,
    mirroredMcpServerRoot: mirrorResult.mirroredMcpServerRoot
  })
  return { ran: true, complete }
}

export function ensureCodexDaemonSocketGuard(runtimeHomePath: string): void {
  try {
    const observation = observeAgentStateFile(join(runtimeHomePath, 'config.toml'))
    if (observation.kind !== 'indeterminate') {
      writeCodexDaemonSocketGuard(
        runtimeHomePath,
        observation.kind === 'present' ? observation.value : null
      )
    }
  } catch (error) {
    console.warn('[codex-config] Failed to apply the Codex daemon socket guard:', error)
  }
}

function writeCodexDaemonSocketGuard(runtimeHomePath: string, runtimeConfig: string | null): void {
  const guarded = applyRuntimeOwnedConfig(runtimeConfig ?? '', runtimeHomePath, runtimeConfig)
  if (guarded !== (runtimeConfig ?? '')) {
    writeFileAtomicallyIfUnchanged(
      join(runtimeHomePath, 'config.toml'),
      runtimeConfig,
      guarded,
      RUNTIME_CONFIG_WRITE
    )
  }
}

/** One-way refresh for retained PTYs; promoting stale settings from this retired home could overwrite live config. */
export function syncSystemConfigIntoLegacySharedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  const systemConfigPath = join(homes.systemHomePath, 'config.toml')
  const runtimeConfigPath = join(homes.runtimeHomePath, 'config.toml')
  recoverInterruptedGuardedFileOperation(runtimeConfigPath)
  const systemConfigObservation = observeAgentStateFile(systemConfigPath)
  if (systemConfigObservation.kind === 'indeterminate') {
    throw systemConfigObservation.error
  }
  const rawSystemConfig =
    systemConfigObservation.kind === 'present' ? systemConfigObservation.value : ''
  const runtimeConfigObservation = observeAgentStateFile(runtimeConfigPath)
  if (runtimeConfigObservation.kind === 'indeterminate') {
    throw runtimeConfigObservation.error
  }
  const runtimeConfigBeforeMirror =
    runtimeConfigObservation.kind === 'present' ? runtimeConfigObservation.value : null
  const daemonGuarded = codexDaemonSocketPathExceedsLimit(homes.runtimeHomePath)
  // A missing cloud-synced source does not prove the user cleared config.
  let mirroredRuntimeConfig = runtimeConfigBeforeMirror ?? ''
  if (rawSystemConfig.trim() !== '') {
    const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(homes.systemHomePath)
    mirroredRuntimeConfig =
      runtimeConfigBeforeMirror !== null
        ? mergeSystemCodexConfigIntoRuntime(
            runtimeConfigBeforeMirror,
            guardSystemConfigForRuntimeMerge(
              prepareSystemConfigForRuntimeMirror(
                rawSystemConfig,
                sourceConfigDir,
                homes.runtimeHomePath
              ),
              homes.runtimeHomePath,
              daemonGuarded
            ),
            sourceConfigDir,
            ...readLegacySharedHomeMcpOwnership(homes.runtimeHomePath)
          )
        : prepareSystemConfigForFreshRuntimeMirror(
            rawSystemConfig,
            sourceConfigDir,
            homes.runtimeHomePath
          )
  }
  const nextRuntimeConfig = applyMeasuredRuntimeOwnedConfig(
    mirroredRuntimeConfig,
    homes.runtimeHomePath,
    runtimeConfigBeforeMirror,
    daemonGuarded
  )
  if ((runtimeConfigBeforeMirror ?? '') === nextRuntimeConfig) {
    return
  }
  // Compare before replacement so concurrent trust writes from retained Codex processes win.
  writeFileAtomicallyIfUnchanged(
    runtimeConfigPath,
    runtimeConfigBeforeMirror,
    nextRuntimeConfig,
    RUNTIME_CONFIG_WRITE
  )
}

// The last baseline identifies system-owned MCP servers; never advance it during this one-way refresh.
function readLegacySharedHomeMcpOwnership(
  runtimeHomePath: string
): [mirroredMcpServerNames: ReadonlySet<string>, mirroredMcpServerRoot: boolean] {
  const observation = observeCodexSettingsBaseline(runtimeHomePath)
  if (observation.kind === 'indeterminate') {
    throw new Error('Codex settings baseline could not be read')
  }
  return observation.kind === 'present'
    ? [observation.baseline.mcpServers, observation.baseline.mcpServerRoot]
    : [new Set(), true]
}

type CodexConfigMirrorResult =
  | { status: 'skipped-missing-source' }
  | { status: 'superseded' }
  | { status: 'refused-indeterminate'; error: unknown }
  | {
      status: 'mirrored'
      preservedConflictKeys: ReadonlySet<string>
      mirroredMcpServerNames: ReadonlySet<string>
      mirroredMcpServerRoot: boolean
    }

function syncSystemConfigIntoManagedCodexHomeUnsafe(
  homes: CodexSettingsPromotionHomes,
  promotionPlan: CodexSettingsPromotionPlan
): CodexConfigMirrorResult {
  const { runtimeHomePath, systemHomePath, guestHome } = homes
  const systemConfigPath = join(systemHomePath, 'config.toml')
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  // Distinguish unavailable paths from absent ones to avoid replacing an unreadable runtime as fresh.
  const systemConfigObservation = observeAgentStateFile(systemConfigPath)
  if (systemConfigObservation.kind === 'indeterminate') {
    return { status: 'refused-indeterminate', error: systemConfigObservation.error }
  }
  const runtimeConfigObservation = observeAgentStateFile(runtimeConfigPath)
  if (runtimeConfigObservation.kind === 'indeterminate') {
    return { status: 'refused-indeterminate', error: runtimeConfigObservation.error }
  }
  const runtimeConfigExists = runtimeConfigObservation.kind === 'present'
  const rawSystemConfig =
    systemConfigObservation.kind === 'present' ? systemConfigObservation.value : ''
  // Missing/blank cloud-synced configs may be unhydrated; preserve existing runtime settings.
  if (rawSystemConfig.trim() === '') {
    writeCodexDaemonSocketGuard(
      runtimeHomePath,
      runtimeConfigExists ? runtimeConfigObservation.value : null
    )
    return runtimeConfigExists
      ? { status: 'skipped-missing-source' }
      : {
          status: 'mirrored',
          preservedConflictKeys: new Set(),
          mirroredMcpServerNames: new Set(),
          mirroredMcpServerRoot: false
        }
  }

  const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(systemHomePath)
  const resourceLinkHome = guestHome ? undefined : runtimeHomePath
  if (!runtimeConfigExists) {
    const freshRuntimeConfig = applyRuntimeOwnedConfig(
      prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir, resourceLinkHome),
      runtimeHomePath,
      null
    )
    const ownership = readMcpServerTomlOwnership(freshRuntimeConfig)
    if (
      !writeFileAtomicallyIfUnchanged(
        runtimeConfigPath,
        null,
        freshRuntimeConfig,
        RUNTIME_CONFIG_WRITE
      )
    ) {
      return { status: 'superseded' }
    }
    return {
      status: 'mirrored',
      preservedConflictKeys: new Set(),
      mirroredMcpServerNames: ownership.names,
      mirroredMcpServerRoot: ownership.ownsRoot
    }
  }

  const daemonGuarded = codexDaemonSocketPathExceedsLimit(runtimeHomePath)
  const systemConfig = guardSystemConfigForRuntimeMerge(
    prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir, resourceLinkHome),
    runtimeHomePath,
    daemonGuarded
  )
  const { names: mirroredMcpServerNames, ownsRoot: mirroredMcpServerRoot } =
    readMcpServerTomlOwnership(systemConfig)
  // Reuse the observed snapshot rather than mixing reads across path-state changes.
  const runtimeConfig = runtimeConfigObservation.value
  const preserved = preserveRuntimeConflictValues(
    mergeSystemCodexConfigIntoRuntime(
      runtimeConfig,
      systemConfig,
      sourceConfigDir,
      promotionPlan.mirroredMcpServers,
      promotionPlan.mirroredMcpServerRoot
    ),
    promotionPlan.runtimeValuesToPreserve
  )
  const nextRuntimeConfig = applyMeasuredRuntimeOwnedConfig(
    preserved.content,
    runtimeHomePath,
    runtimeConfig,
    daemonGuarded
  )
  // Why: hook passes on the trust worker write this file too; a save made since this read wins,
  // and the next pass merges again.
  if (
    nextRuntimeConfig !== runtimeConfig &&
    !writeFileAtomicallyIfUnchanged(
      runtimeConfigPath,
      runtimeConfig,
      nextRuntimeConfig,
      RUNTIME_CONFIG_WRITE
    )
  ) {
    return { status: 'superseded' }
  }
  return {
    status: 'mirrored',
    preservedConflictKeys: preserved.keys,
    mirroredMcpServerNames,
    mirroredMcpServerRoot
  }
}
