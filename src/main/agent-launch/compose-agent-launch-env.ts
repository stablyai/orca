// Shared case-aware environment composer for agent launches. Layers inherited,
// provider-default, and admitted custom-agent env, then reapplies the fresh Orca
// control/attribution keys LAST after deleting every case variant so a stale or
// spoofed pane/hook/token value can never survive. Concrete provider-runtime and
// Orca-minted layers are wired in U3; U2 uses this to measure the effective env
// for payload caps and to prove custom/safe-fallback env never inherits base env.

import { utf8ByteLength } from '../../shared/custom-tui-agent-fields'

/** Combined final shell argv + effective environment UTF-8 budget for
 *  POSIX/WSL/SSH targets (no writer cap exists at HEAD). */
export const POSIX_ARG_ENV_SAFE_MAX_BYTES = 131_072
/** Command-only UTF-8 budget shared by POSIX/WSL/SSH startup writers. */
export const POSIX_STARTUP_COMMAND_MAX_BYTES = 131_072
/** Native-Windows CreateProcess environment block ceiling, measured as
 *  case-folded `key=value\0…\0` UTF-16 code units including the final terminator. */
export const WINDOWS_ENVIRONMENT_BLOCK_MAX_CODE_UNITS = 32_767

// Fresh Orca attribution/control keys the host regenerates on every PTY launch.
// Enumerated from `rg -oNI 'ORCA_[A-Z0-9_]+' src/main src/shared`; only the
// identity/hook/attribution/control keys the host itself mints per launch belong
// here — user-overridable provider keys (CODEX_HOME, GROK_HOME, OPENCODE_CONFIG_DIR,
// …) are intentionally excluded so R29 keeps them user-settable. Custom-agent env
// can never contain these (validation rejects any `orca_`-prefixed key), so this
// deletion targets the inherited process env and provider layers.
export const ORCA_PROTECTED_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKTREE_PATH',
  'ORCA_ROOT_PATH',
  'ORCA_WORKSPACE_ID',
  'ORCA_WORKSPACE_NAME',
  'ORCA_PROFILE_ID',
  'ORCA_AGENT_MODE',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_ATTRIBUTION_SHIM_DIR',
  'ORCA_ENABLE_GIT_ATTRIBUTION',
  'ORCA_GIT_COMMIT_TRAILER',
  'ORCA_SHELL_READY_MARKER',
  'ORCA_USER_DATA_PATH',
  'ORCA_AGENT_TEAMS_SHIM_DIR',
  'ORCA_AGENT_TEAMS_TEAM_ID',
  'ORCA_AGENT_TEAMS_TOKEN'
] as const

export type EnvLayer = Readonly<Record<string, string>>

/** Recomputes base-specific derived shadow keys (e.g. a provider's HOME shadow)
 *  from the effective user-overridable env. Concrete providers land in U3; the
 *  hook keeps the composer reusable without importing provider modules. */
export type DeriveShadowKeys = (effective: Readonly<Record<string, string>>) => EnvLayer

export type ComposeAgentLaunchEnvInput = {
  platform: NodeJS.Platform
  /** Inherited/process env (U3 supplies the real one). */
  inherited?: EnvLayer
  /** Non-user provider runtime defaults (U3). */
  providerDefaults?: EnvLayer
  /** Admitted custom-agent env; empty for built-in/safe-fallback launches. */
  agentEnv?: EnvLayer
  /** Fresh Orca control/attribution values minted per launch (U3). */
  orcaControl?: EnvLayer
  deriveShadowKeys?: DeriveShadowKeys
}

function nullProtoEnv(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function deleteCaseVariants(target: Record<string, string>, key: string): void {
  const lower = key.toLowerCase()
  for (const existing of Object.keys(target)) {
    if (existing.toLowerCase() === lower) {
      delete target[existing]
    }
  }
}

function applyLayer(
  target: Record<string, string>,
  layer: EnvLayer | undefined,
  caseInsensitive: boolean
): void {
  if (!layer) {
    return
  }
  // Own-property iteration only; layers may be null-prototype objects.
  for (const key of Object.keys(layer)) {
    const value = layer[key]
    if (caseInsensitive) {
      // Windows env is case-insensitive: drop any colliding variant before
      // setting so the later layer wins exactly once.
      deleteCaseVariants(target, key)
    } else {
      delete target[key]
    }
    target[key] = value
  }
}

/** Compose the effective launch env from ordered layers. Windows merges keys
 *  case-insensitively; every platform reapplies protected Orca keys last after
 *  deleting all case variants. */
export function composeAgentLaunchEnv(input: ComposeAgentLaunchEnvInput): Record<string, string> {
  const caseInsensitive = input.platform === 'win32'
  const env = nullProtoEnv()
  applyLayer(env, input.inherited, caseInsensitive)
  applyLayer(env, input.providerDefaults, caseInsensitive)
  applyLayer(env, input.agentEnv, caseInsensitive)

  if (input.deriveShadowKeys) {
    // Shadow keys derive from user-overridable values, so recompute after the
    // agent env layer and before the protected keys reclaim their names.
    applyLayer(env, input.deriveShadowKeys(env), caseInsensitive)
  }

  // Protected keys win over every prior case variant on all platforms so a
  // stale/spoofed pane/hook/token value can never leak past the host's own.
  for (const protectedKey of ORCA_PROTECTED_ENV_KEYS) {
    deleteCaseVariants(env, protectedKey)
  }
  applyLayer(env, input.orcaControl, caseInsensitive)
  return env
}

/** The layer a spawned child actually inherits: `process.env` values are typed
 *  `string | undefined` and an undefined key is absent from the child's block. */
export function inheritedEnvLayer(source: NodeJS.ProcessEnv): EnvLayer {
  const layer = nullProtoEnv()
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value !== undefined) {
      layer[key] = value
    }
  }
  return layer
}

/** Native-Windows environment-block size in UTF-16 code units: each entry is
 *  `key=value\0`, with one extra terminating NUL after the final entry. */
export function measureWindowsEnvironmentBlockCodeUnits(env: EnvLayer): number {
  let codeUnits = 0
  for (const key of Object.keys(env)) {
    codeUnits += `${key}=${env[key]}`.length + 1
  }
  return codeUnits + 1
}

/** Combined UTF-8 byte size of the final shell argv plus the effective env, used
 *  for the POSIX/WSL/SSH payload cap. */
export function measurePosixArgEnvBytes(argv: readonly string[], env: EnvLayer): number {
  let bytes = 0
  for (const arg of argv) {
    bytes += utf8ByteLength(arg) + 1
  }
  for (const key of Object.keys(env)) {
    bytes += utf8ByteLength(`${key}=${env[key]}`) + 1
  }
  return bytes
}
