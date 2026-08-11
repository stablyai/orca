import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readAgentStateFileSync } from '../agent-state-file-reader'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'
import type {
  CodexConfigSyncStallReason,
  CodexConfigSyncStatus
} from '../../shared/codex-config-sync-types'

/**
 * Reports whether the managed Codex runtime config is still tracking the user's
 * real `~/.codex/config.toml`, and why it is not when it has fallen behind.
 *
 * The mirror preserves the managed runtime config when the source is missing or
 * blank, which is silent by design — but the stall can persist for every launch
 * (a downed WSL distro, an unhydrated cloud-synced home), leaving "Orca ignores
 * my config edits" with nothing to diagnose. Derived on demand from the same
 * predicates the mirror uses, so the two can never disagree.
 */
export function getCodexConfigSyncStatus(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): CodexConfigSyncStatus {
  const systemConfigPath = join(homes.systemHomePath, 'config.toml')
  const runtimeConfigPath = join(homes.runtimeHomePath, 'config.toml')
  // Why: a stall only withholds settings once a managed runtime config exists;
  // without one the mirror seeds it and there is nothing yet to fall behind.
  if (!existsSync(runtimeConfigPath)) {
    return { state: 'synced', reason: null, systemConfigPath }
  }
  if (!existsSync(systemConfigPath)) {
    return { state: 'stalled', reason: 'missing-source', systemConfigPath }
  }
  let rawSystemConfig: string
  try {
    rawSystemConfig = readAgentStateFileSync(systemConfigPath)
  } catch {
    // Why: the mirror aborts on an unreadable source too, so report the stall
    // rather than claiming a sync that cannot happen.
    return { state: 'stalled', reason: 'unreadable-source', systemConfigPath }
  }
  if (rawSystemConfig.trim() === '') {
    return { state: 'stalled', reason: 'blank-source', systemConfigPath }
  }
  return { state: 'synced', reason: null, systemConfigPath }
}

// Why: the mirror runs on every launch and on the quota poll, so logging each
// skip would bury the log. Latch per home and log the transition instead, so an
// ongoing stall stays one line and a recovery is visible.
const stalledHomes = new Map<string, CodexConfigSyncStallReason>()

/**
 * Logs a config-sync stall once per episode instead of once per sync pass, and
 * logs again when the stall clears or its reason changes.
 *
 * Pass `mirrorError` from the mirror's catch path — an unreadable source throws
 * out of the mirror, and without it that stall would log the raw failure on
 * every launch and quota poll while never latching.
 */
export function reportCodexConfigSyncOutcome(
  runtimeHomePath: string,
  status: CodexConfigSyncStatus,
  mirrorError?: unknown
): void {
  const previousReason = stalledHomes.get(runtimeHomePath)
  if (status.state === 'synced') {
    if (previousReason) {
      stalledHomes.delete(runtimeHomePath)
      // Why: a removed runtime config also reads as synced, so this cannot
      // claim the source became readable — only that the stall no longer holds.
      console.warn(
        `[codex-config] Config sync stall cleared for ${runtimeHomePath} (was ${previousReason}).`
      )
    }
    if (mirrorError) {
      // Why: the mirror still failed for some reason the stall check cannot
      // name, so surface it rather than swallowing it behind a clean status.
      console.warn('[codex-config] Failed to mirror system Codex config:', mirrorError)
    }
    return
  }
  if (previousReason === status.reason) {
    return
  }
  stalledHomes.set(runtimeHomePath, status.reason)
  console.warn(
    `[codex-config] Config sync stalled (${status.reason}): ${status.systemConfigPath} is unusable, so ${runtimeHomePath} keeps its last synced settings. Edits to the source will not apply until it is readable.`
  )
}

/** Clears the per-home episode latch; the latch is module state, so suites that assert on transitions need a clean slate between cases. */
export function resetCodexConfigSyncStallLatchForTests(): void {
  stalledHomes.clear()
}
