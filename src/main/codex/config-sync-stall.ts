import { join } from 'node:path'
import { observeAgentStateFile } from './codex-path-observation'
import { isOnlyCodexDaemonOverride } from './codex-daemon-socket-path-guard'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  getCodexSettingsBaselinePath,
  observeCodexSettingsBaseline
} from './config-settings-baseline'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'
import type {
  CodexConfigSyncStallReason,
  CodexConfigSyncStatus
} from '../../shared/codex-config-sync-types'

/** Diagnose settings withheld by a stalled mirror from the current file observations. */
export function getCodexConfigSyncStatus(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): CodexConfigSyncStatus {
  const systemConfigPath = join(homes.systemHomePath, 'config.toml')
  const runtimeConfigPath = join(homes.runtimeHomePath, 'config.toml')
  // Read content so an unreadable runtime cannot be reported as synced.
  const runtimeConfigObservation = observeAgentStateFile(runtimeConfigPath)
  // An absent or daemon-only runtime withholds no user settings.
  if (
    runtimeConfigObservation.kind === 'absent' ||
    (runtimeConfigObservation.kind === 'present' &&
      isOnlyCodexDaemonOverride(runtimeConfigObservation.value))
  ) {
    return { state: 'synced', reason: null, systemConfigPath }
  }
  if (runtimeConfigObservation.kind === 'indeterminate') {
    return {
      state: 'stalled',
      reason: 'managed-home-unavailable',
      systemConfigPath,
      managedStatePath: runtimeConfigPath
    }
  }
  const baselineObservation = observeCodexSettingsBaseline(homes.runtimeHomePath)
  if (baselineObservation.kind === 'indeterminate') {
    return {
      state: 'stalled',
      reason: 'managed-home-unavailable',
      systemConfigPath,
      managedStatePath: getCodexSettingsBaselinePath(homes.runtimeHomePath)
    }
  }
  const systemConfigObservation = observeAgentStateFile(systemConfigPath)
  if (systemConfigObservation.kind === 'absent') {
    return { state: 'stalled', reason: 'missing-source', systemConfigPath }
  }
  if (systemConfigObservation.kind === 'indeterminate') {
    return { state: 'stalled', reason: 'unreadable-source', systemConfigPath }
  }
  const rawSystemConfig = systemConfigObservation.value
  if (rawSystemConfig.trim() === '') {
    return { state: 'stalled', reason: 'blank-source', systemConfigPath }
  }
  return { state: 'synced', reason: null, systemConfigPath }
}

// Latch per home to avoid repeating warnings on every launch and quota poll.
const stalledHomes = new Map<string, CodexConfigSyncStallReason>()

/** Pass mirrorError from catch paths so unreadable-source failures also latch. */
export function reportCodexConfigSyncOutcome(
  runtimeHomePath: string,
  status: CodexConfigSyncStatus,
  mirrorError?: unknown
): void {
  const previousReason = stalledHomes.get(runtimeHomePath)
  if (status.state === 'synced') {
    if (previousReason) {
      stalledHomes.delete(runtimeHomePath)
      // A removed runtime also clears the stall without proving the source readable.
      console.warn(
        `[codex-config] Config sync stall cleared for ${runtimeHomePath} (was ${previousReason}).`
      )
    }
    if (mirrorError) {
      // Surface failures outside the conditions this status check can identify.
      console.warn('[codex-config] Failed to mirror system Codex config:', mirrorError)
    }
    return
  }
  if (previousReason === status.reason) {
    return
  }
  stalledHomes.set(runtimeHomePath, status.reason)
  if (status.reason === 'managed-home-unavailable') {
    const managedStatePath = status.managedStatePath ?? join(runtimeHomePath, 'config.toml')
    console.warn(
      `[codex-config] Config sync stalled (${status.reason}): ${managedStatePath} is unusable, so ${runtimeHomePath} keeps its last synced settings. The managed state must be readable before settings can sync.`
    )
    return
  }
  console.warn(
    `[codex-config] Config sync stalled (${status.reason}): ${status.systemConfigPath} is unusable, so ${runtimeHomePath} keeps its last synced settings. Edits to the source will not apply until it is readable.`
  )
}

export function resetCodexConfigSyncStallLatchForTests(): void {
  stalledHomes.clear()
}
