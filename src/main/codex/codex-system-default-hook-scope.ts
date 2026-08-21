import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

/**
 * Scope of Orca status-hook enrollment for the System Default Codex home.
 *
 * - `orca-sessions`: install only into Orca-managed CODEX_HOME for launches
 *   from Orca. Never mutate the shared `~/.codex` hook layer. Safer default.
 * - `all-sessions`: enroll the real system home so every Codex process using
 *   that home (including outside Orca) loads the status relay.
 */
export type CodexSystemDefaultHookScope = 'orca-sessions' | 'all-sessions'

export type SystemDefaultHookInstallPlan =
  | { action: 'install-real-home' }
  | { action: 'prefer-managed'; reason: 'orca-sessions-scope' | 'dual-hook-representation' }
  | { action: 'sweep-real-home' }

const SCOPE_ENV = 'ORCA_CODEX_SYSTEM_DEFAULT_HOOK_SCOPE'

/** Safer product default: do not enroll the shared System Default home. */
export function getDefaultCodexSystemDefaultHookScope(): CodexSystemDefaultHookScope {
  return 'orca-sessions'
}

/**
 * Resolves the effective scope. Env override is test/power-user only — no UI
 * setting yet; production default stays `orca-sessions`.
 */
export function resolveCodexSystemDefaultHookScope(
  env: NodeJS.ProcessEnv = process.env
): CodexSystemDefaultHookScope {
  const raw = env[SCOPE_ENV]?.trim().toLowerCase()
  if (raw === 'all-sessions' || raw === 'all' || raw === 'system-default' || raw === 'real-home') {
    return 'all-sessions'
  }
  if (raw === 'orca-sessions' || raw === 'orca' || raw === 'orca-only' || raw === 'managed') {
    return 'orca-sessions'
  }
  return getDefaultCodexSystemDefaultHookScope()
}

/**
 * Pure install-target decision for System Default status hooks.
 * Dual-representation always wins over `all-sessions`: never create hooks.json
 * when config.toml already carries user-layer hook definitions.
 */
export function planSystemDefaultHookInstall(args: {
  scope: CodexSystemDefaultHookScope
  hooksEnabled: boolean
  configTomlHasUserHookDefinitions: boolean
}): SystemDefaultHookInstallPlan {
  if (!args.hooksEnabled) {
    return { action: 'sweep-real-home' }
  }
  if (args.scope === 'orca-sessions') {
    return { action: 'prefer-managed', reason: 'orca-sessions-scope' }
  }
  if (args.configTomlHasUserHookDefinitions) {
    return { action: 'prefer-managed', reason: 'dual-hook-representation' }
  }
  return { action: 'install-real-home' }
}

/**
 * True when config.toml declares executable hook definitions (array-of-tables
 * or tables under `hooks.*` other than `hooks.state`). Trust-only `[hooks.state.*]`
 * does not count — Orca writes those alongside hooks.json intentionally.
 */
export function configTomlHasUserLayerHookDefinitions(toml: string): boolean {
  const lines = toml.split('\n')
  let scanState = createTomlLineScanState()
  for (const line of lines) {
    if (isTomlStructuralLine(scanState)) {
      const header = getTomlTableHeader(line)
      if (header && isUserLayerHookDefinitionHeader(header)) {
        return true
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return false
}

function isUserLayerHookDefinitionHeader(header: string): boolean {
  const trimmed = header.trim()
  // [[hooks.Stop]] / [hooks.Stop] / [[hooks.Stop.hooks]] — not [hooks.state.*]
  const match = /^\[\[?\s*hooks(?:\.(.+))?\s*\]\]?$/.exec(trimmed)
  if (!match) {
    return false
  }
  const rest = match[1]
  if (rest === undefined || rest === '') {
    // Bare [hooks] / [[hooks]] is a hook-definition container, not trust state.
    return true
  }
  const firstSegment = rest.split('.')[0]?.trim().toLowerCase()
  return firstSegment !== 'state'
}
