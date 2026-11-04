import { readMcpServerTomlOwnership } from '../toml/config-toml-mcp-servers'
import { dirname, join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import { writeFileAtomically } from '../../../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../homes/codex-home-paths'
import {
  applyRuntimeConfigOverrides,
  ensureRuntimeConfigOverridesForHomes,
  RUNTIME_CONFIG_WRITE,
  writeRuntimeConfigOverrides
} from './codex-managed-home-runtime-overrides'

export { ensureCodexRuntimeConfigOverrides } from './codex-managed-home-runtime-overrides'
import {
  rebaseBundledMarketplaceSources,
  rewriteRelativePathConfigValues
} from './codex-config-path-reference-rewrite'
import { normalizeDeprecatedCodexHookFeatureFlag } from '../toml/config-toml-deprecated-hook-flag'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline,
  type CodexSettingsPromotionHomes,
  type CodexSettingsPromotionPlan
} from './config-settings-promotion'
import { readCodexSettingsBaseline } from './config-settings-baseline'
import { getCodexConfigSyncStatus, reportCodexConfigSyncOutcome } from './config-sync-stall'
import { preserveRuntimeConflictValues } from './codex-config-settings-preservation'
import { stripRuntimeOwnedTomlSections } from '../toml/config-toml-runtime-owned-sections'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'

export function syncSystemConfigIntoManagedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  if (!mirrorSystemConfigIntoManagedCodexHome(homes)) {
    // Apply the runtime overrides even on mirror stalls so long home paths can still launch Codex.
    ensureRuntimeConfigOverridesForHomes(homes)
  }
}

/** Returns false when no mirror pass ran, so the caller still owes the daemon guard. */
function mirrorSystemConfigIntoManagedCodexHome(homes: CodexSettingsPromotionHomes): boolean {
  // Promote in-chat changes before mirroring ~/.codex or this pass would revert them.
  const promotionPlan = promoteCodexRuntimeSettingsToSystem(homes)
  if (!promotionPlan) {
    // Preserve runtime/baseline for retry; promotion failures must report stalls without clearing the latch.
    const stalledStatus = getCodexConfigSyncStatus(homes)
    if (stalledStatus.state === 'stalled') {
      reportCodexConfigSyncOutcome(homes.runtimeHomePath, stalledStatus)
    }
    return false
  }
  let mirrorResult: CodexConfigMirrorResult
  try {
    mirrorResult = syncSystemConfigIntoManagedCodexHomeUnsafe(homes, promotionPlan)
  } catch (error) {
    // Latch mirror failures too, so the user sees their cause without repeated generic logging.
    reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes), error)
    return false
  }
  if (mirrorResult.status === 'refused-indeterminate') {
    // Keep the baseline unchanged on indeterminate reads so unmirrored changes can retry.
    reportCodexConfigSyncOutcome(
      homes.runtimeHomePath,
      getCodexConfigSyncStatus(homes),
      mirrorResult.error
    )
    return false
  }
  reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes))
  if (mirrorResult.status === 'skipped-missing-source') {
    // Bootstrap seeded homes only; advancing an existing baseline would strand unmirrored changes.
    if (!readCodexSettingsBaseline(homes.runtimeHomePath)) {
      snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath)
    }
    return true
  }
  // Advance the baseline only after mirroring so unpromoted changes remain eligible for retry.
  snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath, {
    conflicts: new Map(
      [...promotionPlan.conflicts].filter(([key]) => mirrorResult.preservedConflictKeys.has(key))
    ),
    // Missing marketplace/plugin tables in later source configs now count as removals.
    mirroredRegistrations: true,
    mirroredMcpServers: mirrorResult.mirroredMcpServerNames,
    mirroredMcpServerRoot: mirrorResult.mirroredMcpServerRoot
  })
  return true
}

type CodexConfigMirrorResult =
  | { status: 'skipped-missing-source' }
  | { status: 'refused-indeterminate'; error: unknown }
  | {
      status: 'mirrored'
      preservedConflictKeys: ReadonlySet<string>
      mirroredMcpServerNames: ReadonlySet<string>
      mirroredMcpServerRoot: boolean
    }

function syncSystemConfigIntoManagedCodexHomeUnsafe(
  { runtimeHomePath, systemHomePath, systemConfigDir }: CodexSettingsPromotionHomes,
  promotionPlan: CodexSettingsPromotionPlan
): CodexConfigMirrorResult {
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
    writeRuntimeConfigOverrides(
      { runtimeHomePath, systemHomePath, systemConfigDir },
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

  const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(systemHomePath, systemConfigDir)
  if (!runtimeConfigExists) {
    const preparedRuntimeConfig = prepareSystemConfigForFreshRuntimeMirror(
      rawSystemConfig,
      sourceConfigDir,
      runtimeHomePath
    )
    const freshRuntimeConfig = applyRuntimeConfigOverrides(preparedRuntimeConfig, {
      runtimeHomePath,
      systemHomePath,
      systemConfigDir
    })
    // Orca's own override is not mirrored source state; keep it out of the ownership baseline.
    const ownership = readMcpServerTomlOwnership(preparedRuntimeConfig)
    writeFileAtomically(runtimeConfigPath, freshRuntimeConfig, RUNTIME_CONFIG_WRITE)
    return {
      status: 'mirrored',
      preservedConflictKeys: new Set(),
      mirroredMcpServerNames: ownership.names,
      mirroredMcpServerRoot: ownership.ownsRoot
    }
  }

  const systemConfig = prepareSystemConfigForRuntimeMirror(
    rawSystemConfig,
    sourceConfigDir,
    runtimeHomePath
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
  const nextRuntimeConfig = applyRuntimeConfigOverrides(preserved.content, {
    runtimeHomePath,
    systemHomePath,
    systemConfigDir
  })
  if (nextRuntimeConfig !== runtimeConfig) {
    writeFileAtomically(runtimeConfigPath, nextRuntimeConfig, RUNTIME_CONFIG_WRITE)
  }
  return {
    status: 'mirrored',
    preservedConflictKeys: preserved.keys,
    mirroredMcpServerNames,
    mirroredMcpServerRoot
  }
}

export function resolveCodexConfigMirrorSourceDirectory(
  systemHomePath: string,
  systemConfigDir?: string
): string {
  return (
    systemConfigDir ??
    parseWslUncPath(systemHomePath)?.linuxPath ??
    dirname(join(systemHomePath, 'config.toml'))
  )
}

export function prepareSystemConfigForRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  const prepared = rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(config),
    systemConfigDir
  )
  // WSL guest homes do not receive host resource links.
  return runtimeHomePath && !parseWslUncPath(runtimeHomePath)
    ? rebaseBundledMarketplaceSources(prepared, systemConfigDir, runtimeHomePath)
    : prepared
}

// Install re-keys user-hook trust; plugin/project trust carries unchanged.
// WSL systemConfigDir must name the Linux-side config directory.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  return stripRuntimeOwnedTomlSections(
    prepareSystemConfigForRuntimeMirror(config, systemConfigDir, runtimeHomePath),
    new Set(),
    { systemHomeDir: systemConfigDir, runtimeHookTrustKeys: new Set() }
  )
}
