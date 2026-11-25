// Kept apart from ./command, which many tests mock whole, so error paths always see these.
/** procfs takes no new entries, so nothing ever exists here. */
export const WINDOWS_ONLY_AGENT_CLI_DIR = '/proc/orca-agent-cli-installed-only-on-windows'

export function isWindowsOnlyAgentCommand(command: string): boolean {
  return command.startsWith(`${WINDOWS_ONLY_AGENT_CLI_DIR}/`)
}

/** What sign-in and status surfaces say when the only copy is the Windows one; null otherwise. */
export function windowsOnlyCliMessage(command: string, agent: string): string | null {
  return isWindowsOnlyAgentCommand(command)
    ? `${agent} is installed only on Windows, not in this WSL distro. Install it inside the distro.`
    : null
}

/** Codex's spawn ENOENT: missing (bare name, or only a Windows copy), or a found CLI without its Node. */
export function codexSpawnEnoent(command: string): { message: string; missing: boolean } {
  const windowsOnly = windowsOnlyCliMessage(command, 'Codex')
  if (windowsOnly) {
    return { message: windowsOnly, missing: true }
  }
  return command === 'codex'
    ? { message: 'Codex CLI not found.', missing: true }
    : {
        message: 'Codex CLI found but could not run — Node.js may not be in your PATH.',
        missing: false
      }
}

export function isSpawnEnoent(error: Error): boolean {
  return 'code' in error && error.code === 'ENOENT'
}
