/** Allowlist child environments to exclude secrets and Node flags that override heap caps or load code. */

// Also used by the plain-node WSL transcript filesystem process.
export const RUNTIME_ENV_ALLOWLIST = [
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
  // Windows Node/libuv need these to resolve DLLs and the machine root.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS'
] as const

// Preserve relocated agent homes for desktop discovery.
const AGENT_ROOT_ENV_ALLOWLIST = [
  // Managed Windows profiles can relocate Devin’s data through APPDATA.
  'APPDATA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CLINE_SESSION_DATA_DIR',
  'COPILOT_HOME',
  'DEVIN_HOME',
  'GROK_HOME',
  'KIMI_CODE_HOME',
  'KIRO_HOME',
  'OMP_CODING_AGENT_DIR',
  'OMP_PROFILE',
  'OPENCLAW_STATE_DIR',
  'OPENCODE_DB',
  'PI_CODING_AGENT_DIR',
  'PI_CONFIG_DIR',
  'PI_PROFILE',
  'PRIME_AGENT_CODING_AGENT_DIR',
  'PRIME_AGENT_CODING_AGENT_SESSION_DIR',
  'PRIME_AGENT_SESSION_DIR',
  // OpenCode and migrated OMP stores follow the XDG data root.
  'XDG_DATA_HOME'
] as const

export function pickAllowedEnv(
  keys: readonly string[],
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const windowsLookup = new Map<string, string>()
  if (platform === 'win32') {
    // Fold Windows env names only; POSIX path must not override PATH.
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

/** Relay init supplies most roots; preserve host-side Kiro and OpenCode overrides. */
export function buildRelayAiVaultServiceEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return pickAllowedEnv(
    [...RUNTIME_ENV_ALLOWLIST, 'XDG_DATA_HOME', 'OPENCODE_DB', 'KIRO_HOME'],
    baseEnv,
    platform
  )
}
