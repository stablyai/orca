const WSLENV_ENTRY_SEPARATOR = ':'

function parseWslenvEntries(value: string | undefined): string[] {
  return value ? value.split(WSLENV_ENTRY_SEPARATOR).filter(Boolean) : []
}

function upsertWslenvEntry(entries: string[], entry: string): void {
  const variableName = entry.split('/')[0]
  const existingIndex = entries.findIndex((value) => value.split('/')[0] === variableName)
  if (existingIndex === -1) {
    entries.push(entry)
    return
  }
  entries[existingIndex] = entry
}

function applyWslenvPassthrough(
  env: Record<string, string | undefined>,
  passthroughEntries: string[]
): void {
  const entries = parseWslenvEntries(env.WSLENV)
  for (const entry of passthroughEntries) {
    const variableName = entry.split('/')[0]
    if (env[variableName]) {
      upsertWslenvEntry(entries, entry)
    }
  }
  env.WSLENV = entries.join(WSLENV_ENTRY_SEPARATOR)
}

function worktreeSetupWslenvEntries(env: Record<string, string | undefined>): string[] {
  return [
    // Why: worktree setup/hook scripts read these (#9206). For WSL worktrees
    // hooks.ts pre-translates the values to Linux paths (must cross untranslated,
    // /u); a wsl.exe terminal over a Windows worktree still carries C:\ paths
    // that WSLENV must translate (/p).
    ...['ORCA_ROOT_PATH', 'ORCA_WORKTREE_PATH', 'CONDUCTOR_ROOT_PATH', 'GHOSTX_ROOT_PATH'].map(
      (name) => `${name}/${env[name]?.startsWith('/') ? 'u' : 'p'}`
    ),
    // Why: a display name, never a path — never path-translate it.
    'ORCA_WORKSPACE_NAME/u'
  ]
}

// Why: runHook spawns wsl.exe directly (archive hooks, windowless setup), and
// wsl.exe only imports Windows env vars named in WSLENV — so the setup vars
// must be registered there too, with the same /u-vs-/p flags as the PTY path (#9206).
export function addWorktreeSetupWslInteropEnv(env: Record<string, string | undefined>): void {
  applyWslenvPassthrough(env, worktreeSetupWslenvEntries(env))
}

export function addOrcaWslInteropEnv(env: Record<string, string>): void {
  // Why: the endpoint is a Windows path (/p-translated so the guest reads it
  // via /mnt/c) until the WSL hook relay reports the guest home — then it is
  // already a guest-side POSIX path and must cross untranslated.
  const endpointFlag = env.ORCA_AGENT_HOOK_ENDPOINT?.startsWith('/') ? 'u' : 'p'
  // Why: wsl.exe only imports selected Windows env vars, so WSL needs the wrapper root, pane identity, and hook/OMP coordinates at start.
  const passthroughEntries = [
    'ORCA_TERMINAL_HANDLE/u',
    'ORCA_USER_DATA_PATH/p',
    'ORCA_CLI_COMMAND/u',
    'ORCA_PANE_KEY/u',
    'ORCA_TAB_ID/u',
    'ORCA_WORKTREE_ID/u',
    'ORCA_AGENT_LAUNCH_TOKEN/u',
    'ORCA_AGENT_HOOK_PORT/u',
    'ORCA_AGENT_HOOK_TOKEN/u',
    'ORCA_AGENT_HOOK_ENV/u',
    'ORCA_AGENT_HOOK_VERSION/u',
    `ORCA_AGENT_HOOK_ENDPOINT/${endpointFlag}`,
    'ORCA_WSL_HOOK_RELAY_VERSION/u',
    'ORCA_WSL_HOOK_INSTANCE/u',
    'ORCA_OMP_SOURCE_AGENT_DIR/p',
    'ORCA_OMP_STATUS_EXTENSION/p',
    ...worktreeSetupWslenvEntries(env)
  ]
  applyWslenvPassthrough(env, passthroughEntries)
}
