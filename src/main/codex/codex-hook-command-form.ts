import { ORCA_HOME_DIR_NAME } from '../../shared/orca-home'
/**
 * The Codex hook command every Orca build writes, frozen per form.
 *
 * Why frozen: ~/.codex is shared by every Orca instance and build on this
 * HOME. Bytes that depend on the build make two builds rewrite each other's
 * entry, with a Codex trust session each time. A form changes only with a
 * bump here, and a build never rewrites an entry of a higher form.
 */
export const CODEX_HOOK_COMMAND_FORM = 1

const FORM_MARKER = /orca-agent-hook-form=(\d+)/

// Why literals, not the shared hook constants: a change there must not move these bytes.
const POSIX_STDIN_DRAIN = '{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :'

// Why: a path of only these runs bare under every Windows host Codex uses
// (PowerShell 7 or 5.1 from the turn's shell, else %COMSPEC% /C); any other
// character takes the cmd spelling. Neither spelling can carry a marker, so
// later forms change the script, never these bytes.
const WINDOWS_BARE_PATH = /^[A-Za-z0-9_.:/~-]+$/

function buildPosixCommand(): string {
  const rootScript = '"${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh"'
  const sharedScript = `"\${HOME-}/${ORCA_HOME_DIR_NAME}/agent-hooks/codex-hook.sh"`
  // Why the root branch: dormant until Orca sets ORCA_AGENT_HOOK_ROOT, so the
  // bytes need not change when it does. The shared branch needs a hook port,
  // so a pane with hooks off and every shell outside Orca only drain stdin.
  return [
    `: orca-agent-hook-form=${CODEX_HOOK_COMMAND_FORM};`,
    `if [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f ${rootScript} ]; then /bin/sh ${rootScript} || :;`,
    `elif [ -z "\${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "\${ORCA_PANE_KEY-}" ] && [ -n "\${ORCA_AGENT_HOOK_PORT-}" ] && [ -f ${sharedScript} ]; then /bin/sh ${sharedScript} || :;`,
    `else ${POSIX_STDIN_DRAIN}; fi`
  ].join(' ')
}

// Why an absolute, unquoted, backslashed cmd.exe: PowerShell resolves a bare `cmd`
// through PATH (a cmd.bat earlier on PATH runs instead), reads a quoted first
// token as an expression, and cmd.exe parses a forward-slash argv0 as switches.
const WINDOWS_DIRECTORY = /^[A-Za-z]:(?:\/[A-Za-z0-9_.~-]+)+$/
const COMSPEC_IN_SYSTEM32 = /^(.+)\/system32\/cmd\.exe$/i
// Why: still absolute when neither variable names a directory it can spell unquoted.
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
  // Why: `--%` passes the rest to cmd.exe verbatim under PowerShell, /v:off keeps
  // a registry-enabled delayed expansion from expanding a `!NAME!` pair in the path,
  // and the `@` stops cmd.exe stripping the quotes around a path holding & or ^.
  const cmdExe = `${resolveWindowsDirectory(env)}/System32/cmd.exe`.replaceAll('/', '\\')
  return `${cmdExe} --% /d /v:off /c @"${forwardSlashPath}"`
}

/**
 * `scriptPath` is the shared script at `~/.orca/agent-hooks`; only Windows forms
 * embed it. On Windows the bytes depend only on it and on %SystemRoot% (else
 * %ComSpec%), both fixed per machine.
 */
export function buildCodexHookCommand(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
  env: WindowsDirectoryEnv = process.env
): string {
  return platform === 'win32' ? buildWindowsCommand(scriptPath, env) : buildPosixCommand()
}

/**
 * The form of an Orca-shaped Codex hook command. 0 is any form from before the
 * frozen command, including every retired one.
 */
export function readCodexHookCommandForm(command: string, currentCommand: string): number {
  if (command === currentCommand) {
    return CODEX_HOOK_COMMAND_FORM
  }
  const marker = FORM_MARKER.exec(command)
  return marker ? Number(marker[1]) : 0
}
