import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS } from './codex-hook-trust-grant'
import { getSystemCodexHomePath } from './codex-home-paths'
import { installRealHomeCodexHooks, sweepRealHomeCodexHooks } from './codex-real-home-hook-mutation'
import {
  configTomlHasUserLayerHookDefinitions,
  planSystemDefaultHookInstall,
  resolveCodexSystemDefaultHookScope
} from './codex-system-default-hook-scope'

/**
 * Real-home Codex hook lane for the system-default selection (flag ON).
 *
 * - 'pending': no attempt yet this process; routing may optimistically use the
 *   real home (reads are hook-free and the install runs before pane spawns).
 * - 'installed': entry appended LAST in ~/.codex/hooks.json and trusted by
 *   codex itself through the app-server grant client (`all-sessions` scope).
 * - 'orca-sessions': safer default scope — real home is not enrolled; Orca
 *   launches use the managed CODEX_HOME where status hooks live.
 * - 'unavailable': the grant lane could not trust the entry (old binary,
 *   unsupported RPC, verify failure) or dual-representation would collide
 *   with user config.toml hooks. The entry is rolled back / never written and
 *   the host stays on the managed-home lane.
 * - 'removed': hooks are opted out; Orca entries are swept from the real home.
 */
export type RealHomeCodexHookLane =
  | 'pending'
  | 'installed'
  | 'orca-sessions'
  | 'unavailable'
  | 'removed'

let currentLane: RealHomeCodexHookLane = 'pending'
let installRetryAfterMs = 0

export function getRealHomeCodexHookLane(): RealHomeCodexHookLane {
  return currentLane
}

/**
 * Routing gate consumed by CodexRuntimeHomeService. Failed installs, dual-
 * representation fallback, and the orca-sessions scope all keep the host on
 * the managed lane so PTY / rate-limit / commit-message routing stay aligned.
 */
export function isRealHomeCodexHookLaneUsable(): boolean {
  return currentLane !== 'unavailable' && currentLane !== 'orca-sessions'
}

function getRealHomeConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

/**
 * Ensures the real-home hook state matches the settings and scope: installs
 * and trusts the Orca status hook when `all-sessions` is selected, otherwise
 * sweeps the real home and keeps status on the managed CODEX_HOME. Idempotent
 * and synchronous (launch prep). Never throws: any failure logs and leaves
 * the host on the managed lane.
 */
export function ensureRealHomeCodexHookState(args: {
  hooksEnabled: boolean
  userDataPath: string
}): RealHomeCodexHookLane {
  // Why: the grant client caches failed probes, but mutating and rolling back
  // hooks.json before consulting it still adds synchronous work to every pane.
  if (args.hooksEnabled && currentLane === 'unavailable' && Date.now() < installRetryAfterMs) {
    return currentLane
  }
  try {
    currentLane = reconcileRealHomeCodexHookState(args)
    if (!args.hooksEnabled || currentLane === 'installed' || currentLane === 'orca-sessions') {
      installRetryAfterMs = 0
    }
  } catch (error) {
    console.warn('[codex-real-home-hooks] ensure failed; staying on managed lane:', error)
    currentLane = 'unavailable'
    if (args.hooksEnabled) {
      installRetryAfterMs = Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    }
  }
  return currentLane
}

function reconcileRealHomeCodexHookState(args: {
  hooksEnabled: boolean
  userDataPath: string
}): RealHomeCodexHookLane {
  const scope = resolveCodexSystemDefaultHookScope()
  // Why: orca-sessions never consults config.toml (plan ignores dual-rep for that
  // scope). Skip the sync read on the default path so EACCES/ENOENT races cannot
  // mark the lane unavailable for a decision that does not need the file.
  let configTomlHasUserHookDefinitions = false
  if (scope === 'all-sessions') {
    const configTomlPath = getRealHomeConfigTomlPath()
    try {
      const configToml = existsSync(configTomlPath) ? readFileSync(configTomlPath, 'utf-8') : ''
      configTomlHasUserHookDefinitions = configTomlHasUserLayerHookDefinitions(configToml)
    } catch (error) {
      // Why: fail closed — prefer managed when we cannot prove config.toml is clean.
      console.warn(
        '[codex-real-home-hooks] config.toml read failed; treating as dual-representation risk:',
        error
      )
      configTomlHasUserHookDefinitions = true
    }
  }
  const plan = planSystemDefaultHookInstall({
    scope,
    hooksEnabled: args.hooksEnabled,
    configTomlHasUserHookDefinitions
  })

  if (plan.action === 'sweep-real-home') {
    sweepRealHomeCodexHooks()
    return 'removed'
  }

  if (plan.action === 'prefer-managed') {
    // Why: leave ~/.codex free of Orca status hooks for orca-sessions scope
    // and dual-representation avoidance. Managed CODEX_HOME keeps Orca-launched
    // status reporting working without enrolling external Codex sessions.
    sweepRealHomeCodexHooks()
    if (plan.reason === 'dual-hook-representation') {
      console.warn(
        '[codex-real-home-hooks] config.toml already declares user-layer hooks; ' +
          'skipping real-home hooks.json to avoid dual representation — managed lane kept'
      )
      installRetryAfterMs = Number.POSITIVE_INFINITY
      return 'unavailable'
    }
    return 'orca-sessions'
  }

  const outcome = installRealHomeCodexHooks(args.userDataPath)
  if (outcome.kind === 'unavailable') {
    installRetryAfterMs = outcome.retryAfterMs
  }
  return outcome.kind
}

export const _internals = {
  setLaneForTesting(lane: RealHomeCodexHookLane): void {
    currentLane = lane
    installRetryAfterMs = 0
  }
}
