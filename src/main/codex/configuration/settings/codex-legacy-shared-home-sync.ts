import { join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import {
  recoverInterruptedGuardedFileOperation,
  writeFileAtomicallyIfUnchanged
} from '../../../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../homes/codex-home-paths'
import { observeCodexSettingsBaseline } from './config-settings-baseline'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'
import {
  applyRuntimeConfigOverrides,
  RUNTIME_CONFIG_WRITE
} from './codex-managed-home-runtime-overrides'
import {
  prepareSystemConfigForFreshRuntimeMirror,
  prepareSystemConfigForRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror'

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
  // A missing cloud-synced source does not prove the user cleared config.
  let mirroredRuntimeConfig = runtimeConfigBeforeMirror ?? ''
  if (rawSystemConfig.trim() !== '') {
    const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(homes.systemHomePath)
    mirroredRuntimeConfig =
      runtimeConfigBeforeMirror !== null
        ? mergeSystemCodexConfigIntoRuntime(
            runtimeConfigBeforeMirror,
            prepareSystemConfigForRuntimeMirror(
              rawSystemConfig,
              sourceConfigDir,
              homes.runtimeHomePath
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
  const nextRuntimeConfig = applyRuntimeConfigOverrides(mirroredRuntimeConfig, homes)
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
