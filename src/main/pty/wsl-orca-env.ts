import {
  ORCA_WSL_OPENCODE_MATERIALIZER_ENV,
  ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV
} from '../../shared/wsl-opencode-materializer-contract'

const WSLENV_ENTRY_SEPARATOR = ':'

export { ORCA_WSL_OPENCODE_MATERIALIZER_ENV, ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV }

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

function removeWslenvEntry(entries: string[], variableName: string): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].split('/')[0] === variableName) {
      entries.splice(index, 1)
    }
  }
}

function isGuestPosixPath(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

export function addOrcaWslInteropEnv(env: Record<string, string>): void {
  const entries = parseWslenvEntries(env.WSLENV)
  if (env[ORCA_WSL_OPENCODE_MATERIALIZER_ENV]) {
    // Why: only managed-hook mode replaces the host config with a guest
    // overlay. Hooks-off terminals must preserve intentional user WSLENV.
    for (const variableName of [
      'OPENCODE_CONFIG_DIR',
      'ORCA_OPENCODE_CONFIG_DIR',
      'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
      ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV
    ]) {
      removeWslenvEntry(entries, variableName)
    }
  }
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
    `${ORCA_WSL_OPENCODE_MATERIALIZER_ENV}/p`,
    `${ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV}/u`,
    'ORCA_OMP_SOURCE_AGENT_DIR/p',
    'ORCA_OMP_STATUS_EXTENSION/p'
  ]
  for (const entry of passthroughEntries) {
    const variableName = entry.split('/')[0]
    if (
      variableName === ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV &&
      !isGuestPosixPath(env[variableName])
    ) {
      // Why: this internal source is deliberately /u; a host or UNC path must
      // not be reinterpreted as a guest OpenCode config directory.
      delete env[variableName]
      continue
    }
    if (env[variableName]) {
      upsertWslenvEntry(entries, entry)
    }
  }
  env.WSLENV = entries.join(WSLENV_ENTRY_SEPARATOR)
}
