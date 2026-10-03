import { join } from 'node:path'
import {
  recoverInterruptedGuardedFileOperation,
  writeFileAtomicallyIfUnchanged
} from '../codex-accounts/fs-utils'
import { observeAgentStateFile } from './codex-path-observation'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'
import { applyCodexDaemonSocketGuard } from './codex-daemon-socket-path-guard'
import { refuseUnreadableCodexConfigResult } from './codex-config-toml-checked-edit'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'
import {
  prepareSystemConfigForFreshRuntimeMirror,
  prepareSystemConfigForRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror-source'

/**
 * Refreshes the retired shared home for PTYs that survived real-home rollout.
 *
 * This is deliberately one-way: a retained PTY may hold pre-rollout settings,
 * so treating that home as a promotion source could overwrite the live config.
 */
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
  // Why: a missing cloud-synced source is not proof the user cleared config.
  let mirroredRuntimeConfig = runtimeConfigBeforeMirror ?? ''
  if (rawSystemConfig.trim() !== '') {
    const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(homes.systemHomePath)
    // The retired home has no ownership baseline; its entire MCP root stays canonical.
    mirroredRuntimeConfig =
      runtimeConfigBeforeMirror !== null
        ? mergeSystemCodexConfigIntoRuntime(
            runtimeConfigBeforeMirror,
            prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir),
            sourceConfigDir,
            new Set(),
            true
          )
        : prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir)
  }
  // Why: retained pre-rollout panes still use this home, so a refresh must keep the daemon guard.
  const nextRuntimeConfig = applyCodexDaemonSocketGuard(
    mirroredRuntimeConfig,
    homes.runtimeHomePath
  )
  if (
    (runtimeConfigBeforeMirror ?? '') === nextRuntimeConfig ||
    refuseUnreadableCodexConfigResult({
      configPath: runtimeConfigPath,
      result: nextRuntimeConfig,
      inputs: [rawSystemConfig, runtimeConfigBeforeMirror],
      context: 'Skipped mirroring the Codex config into a managed home'
    })
  ) {
    return
  }
  // Why: stage first, then compare immediately before replace so a retained
  // Codex trust write during mirror preparation wins.
  writeFileAtomicallyIfUnchanged(runtimeConfigPath, runtimeConfigBeforeMirror, nextRuntimeConfig)
}
