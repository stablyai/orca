/**
 * Environments for the AI Vault service children.
 *
 * Deliberately allowlists, never `...process.env` (the plugin worker takes the
 * same stance): the children are forked with a heap cap and no loader, and an
 * ambient NODE_OPTIONS would raise the cap or `--require` code straight into
 * them. Shell-exported secrets have no business in a transcript reader either.
 */

// What Node and libuv need to start and resolve a home, temp dir and locale.
const RUNTIME_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Why: Windows Node/libuv need these to resolve DLLs and the machine root.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS'
] as const

// Why: the desktop child resolves agent roots from its own environment, so
// dropping one hides every session of a user who relocated that agent's home.
const AGENT_ROOT_ENV_ALLOWLIST = [
  'CODEX_HOME',
  'COPILOT_HOME',
  'DEVIN_HOME',
  'GROK_HOME',
  'KIMI_CODE_HOME',
  'OMP_CODING_AGENT_DIR',
  'OPENCLAW_STATE_DIR',
  'OPENCODE_DB',
  'PI_CODING_AGENT_DIR',
  'PRIME_AGENT_CODING_AGENT_DIR',
  'PRIME_AGENT_CODING_AGENT_SESSION_DIR',
  'PRIME_AGENT_SESSION_DIR',
  // Why: OpenCode has no home variable — its store hangs off the XDG data dir,
  // so this one is an agent root here rather than generic runtime state.
  'XDG_DATA_HOME'
] as const

function pickAllowedEnv(
  keys: readonly string[],
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const windowsLookup = new Map<string, string>()
  if (platform === 'win32') {
    // Why: Windows resolves env names case-insensitively, so a lowercased
    // `codex_home` still reaches the child; folding on POSIX instead would
    // promote an attacker-set `path` over the real one.
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value === 'string') {
        windowsLookup.set(key.toUpperCase(), value)
      }
    }
  }
  const env: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    const value = platform === 'win32' ? windowsLookup.get(key) : baseEnv[key]
    if (value !== undefined) {
      env[key === 'SYSTEMROOT' ? 'SystemRoot' : key] = value
    }
  }
  return env
}

/** Desktop: forked from the Electron binary, so it also needs run-as-node. */
export function buildAiVaultServiceEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env = pickAllowedEnv(
    [...RUNTIME_ENV_ALLOWLIST, ...AGENT_ROOT_ENV_ALLOWLIST],
    baseEnv,
    platform
  )
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** Relay: the sidecar takes every root from its init message, not the environment. */
export function buildRelayAiVaultServiceEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return pickAllowedEnv(RUNTIME_ENV_ALLOWLIST, baseEnv, platform)
}
