// Shared HOME builds must freeze command bytes per form to avoid rewrite/trust loops.
// Bump the form to change bytes; preserve entries from higher forms.
export const CODEX_HOOK_COMMAND_FORM = 1

const FORM_MARKER = /orca-agent-hook-form=(\d+)/

// Keep literals independent of shared hook constants to freeze these bytes.
const POSIX_STDIN_DRAIN = '{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :'

// These paths run bare under PowerShell 7/5.1 and %COMSPEC% /C; other characters need cmd quoting.
// Neither Windows spelling carries a form marker: later forms must change the script, not these bytes.
const WINDOWS_BARE_PATH = /^[A-Za-z0-9_.:/~-]+$/

function buildPosixCommand(): string {
  const rootScript = '"${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh"'
  const sharedScript = '"${HOME-}/.orca/agent-hooks/codex-hook.sh"'
  // The root branch stays dormant until Orca sets its root; shared hooks require a pane and port.
  // Outside Orca or with hooks off, only drain stdin, preserving the frozen command bytes.
  return [
    `: orca-agent-hook-form=${CODEX_HOOK_COMMAND_FORM};`,
    `if [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f ${rootScript} ]; then /bin/sh ${rootScript} || :;`,
    `elif [ -z "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_PORT-}" ] && [ -f ${sharedScript} ]; then /bin/sh ${sharedScript} || :;`,
    `else ${POSIX_STDIN_DRAIN}; fi`
  ].join(' ')
}

// Absolute cmd.exe avoids PATH hijacking; PowerShell needs an unquoted command token,
// and cmd.exe needs backslashes to avoid parsing argv0 as switches.
const WINDOWS_DIRECTORY = /^[A-Za-z]:(?:\/[A-Za-z0-9_.~-]+)+$/
const COMSPEC_IN_SYSTEM32 = /^(.+)\/system32\/cmd\.exe$/i
// Keep cmd.exe absolute when environment paths cannot be spelled unquoted.
const DEFAULT_WINDOWS_DIRECTORY = 'C:/Windows'

type WindowsDirectoryEnv = Readonly<Record<string, string | undefined>>

function toForwardSlashDirectory(path: string | undefined): string {
  return (path ?? '').replaceAll('\\', '/').replace(/\/+$/, '')
}

function resolveWindowsDirectory(env: WindowsDirectoryEnv): string {
  const systemRoot = toForwardSlashDirectory(env.SystemRoot)
  if (WINDOWS_DIRECTORY.test(systemRoot)) {
    return systemRoot
  }
  const comSpecRoot = COMSPEC_IN_SYSTEM32.exec(toForwardSlashDirectory(env.ComSpec))?.[1] ?? ''
  return WINDOWS_DIRECTORY.test(comSpecRoot) ? comSpecRoot : DEFAULT_WINDOWS_DIRECTORY
}

function buildWindowsCommand(scriptPath: string, env: WindowsDirectoryEnv): string {
  const forwardSlashPath = scriptPath.replaceAll('\\', '/')
  if (WINDOWS_BARE_PATH.test(forwardSlashPath)) {
    return forwardSlashPath
  }
  // PowerShell's --% passes arguments verbatim; /v:off prevents delayed !NAME! expansion.
  // @ prevents cmd.exe stripping path quotes around & or ^.
  const cmdExe = `${resolveWindowsDirectory(env)}/System32/cmd.exe`.replaceAll('/', '\\')
  return `${cmdExe} --% /d /v:off /c @"${forwardSlashPath}"`
}

/**
 * Only Windows embeds scriptPath (~/.orca/agent-hooks); bytes depend on it and the machine's Windows directory.
 */
export function buildCodexHookCommand(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
  env: WindowsDirectoryEnv = process.env
): string {
  return platform === 'win32' ? buildWindowsCommand(scriptPath, env) : buildPosixCommand()
}

/** Unmarked commands from before the frozen form return 0. */
export function readCodexHookCommandForm(command: string, currentCommand: string): number {
  if (command === currentCommand) {
    return CODEX_HOOK_COMMAND_FORM
  }
  const marker = FORM_MARKER.exec(command)
  return marker ? Number(marker[1]) : 0
}
