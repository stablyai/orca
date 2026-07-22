function upsertWslenvEntry(entries: string[], entry: string): void {
  const variableName = entry.split('/')[0]
  const index = entries.findIndex((value) => value.split('/')[0] === variableName)
  if (index === -1) {
    entries.push(entry)
  } else {
    entries[index] = entry
  }
}

export function isWindowsWslShell(shellPath: string): boolean {
  const shellName = shellPath.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  return shellName === 'wsl.exe' || shellName === 'wsl'
}

export function addSshRelayWslEnv(env: Record<string, string>): void {
  const entries = env.WSLENV?.split(':').filter(Boolean) ?? []
  // Why: wsl.exe imports only allowlisted variables; path flags translate the
  // Windows relay installation into the selected distro's mount layout.
  const passthrough = [
    'ORCA_CLI_COMMAND/p',
    'ORCA_REMOTE_CLI_BIN_DIR/p',
    'ORCA_RELAY_DIR/p',
    'ORCA_RELAY_NODE_PATH/p',
    // Why: the Windows launcher invoked through WSL interop needs the named
    // pipe value on the return trip too; `/u` would make it one-way into WSL.
    'ORCA_RELAY_SOCKET_PATH'
  ]
  for (const entry of passthrough) {
    const variableName = entry.split('/')[0] ?? ''
    if (env[variableName]) {
      upsertWslenvEntry(entries, entry)
    }
  }
  env.WSLENV = entries.join(':')
}
