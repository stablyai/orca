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

export function addOrcaWslInteropEnv(env: Record<string, string>): void {
  const entries = parseWslenvEntries(env.WSLENV)
  // Why: wsl.exe only imports selected Windows env vars, so WSL needs the wrapper root, pane identity, and hook/OMP coordinates at start.
  const passthroughEntries = [
    'ORCA_TERMINAL_HANDLE/u',
    'ORCA_USER_DATA_PATH/p',
    'ORCA_PANE_KEY/u',
    'ORCA_TAB_ID/u',
    'ORCA_WORKTREE_ID/u',
    'ORCA_AGENT_LAUNCH_TOKEN/u',
    'ORCA_AGENT_HOOK_PORT/u',
    'ORCA_AGENT_HOOK_TOKEN/u',
    'ORCA_AGENT_HOOK_ENV/u',
    'ORCA_AGENT_HOOK_VERSION/u',
    'ORCA_AGENT_HOOK_ENDPOINT/p',
    'ORCA_OMP_SOURCE_AGENT_DIR/p',
    'ORCA_OMP_STATUS_EXTENSION/p'
  ]
  for (const entry of passthroughEntries) {
    const variableName = entry.split('/')[0]
    if (env[variableName]) {
      upsertWslenvEntry(entries, entry)
    }
  }
  env.WSLENV = entries.join(WSLENV_ENTRY_SEPARATOR)
}
