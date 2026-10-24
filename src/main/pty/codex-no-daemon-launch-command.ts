import { isAbsolute, win32 as pathWin32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  buildShellCommandFromArgv,
  quoteStartupArg,
  tokenizeStartupCommand
} from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { resolvePathEnvKey } from './windows-environment-path'
import {
  CODEX_NO_DAEMON_SKIP_ARGS,
  CODEX_WINDOWS_TAR_SHIM_DIR_ENV
} from '../../shared/codex-shell-function'

const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i
const COMMAND_LINE_BREAK = /[\r\n]/
const CMD_COMMAND_REPARSE_SENSITIVE = /[%!^&|<>()]/
const CMD_ENV_REPARSE_SENSITIVE = /[%!^&|<>\r\n]/
const POSIX_REBUILD_SENSITIVE = /[$*?{}~()![\]]/
const NO_DAEMON_SKIP_ARGS: ReadonlySet<string> = new Set(CODEX_NO_DAEMON_SKIP_ARGS)
// Why bounded: a hung binary must not hold the pane; a slow probe only costs the flag.
const HELP_PROBE_TIMEOUT_MS = 5_000

function buildPosixWindowsTarScopedCommand(argv: readonly string[]): string {
  const script = [
    'orca_codex_tar_path="$1"',
    'shift',
    'if [ -n "$orca_codex_tar_path" ] && command -v cygpath >/dev/null 2>&1; then orca_codex_tar_path=$(cygpath -u "$orca_codex_tar_path" 2>/dev/null || printf \'%s\' "$orca_codex_tar_path"); fi',
    'if [ -n "$orca_codex_tar_path" ]; then PATH="$orca_codex_tar_path:$PATH" exec "$@"; fi',
    'exec "$@"'
  ].join('; ')
  // Why sh: the outer `posix` shell may be fish; rebuilt argv enters one known grammar.
  return `sh -c ${quoteStartupArg(script, 'posix')} orca-codex-tar "$${CODEX_WINDOWS_TAR_SHIM_DIR_ENV}" ${buildShellCommandFromArgv(argv, 'posix')}`
}

export type LocalCodexLaunch = {
  command: string | undefined
  /** False for SSH and WSL spawns: their shell's codex function probes on that host. */
  executesOnThisHost: boolean
  /** Shell the provider will launch; undefined means the platform default. */
  shellOverride: string | undefined
  /** Env the PTY gets on top of this process's own. */
  env: Record<string, string | undefined> | undefined
  /** Keys the provider removes from that merged env. */
  envToDelete?: readonly string[]
  cwd: string | undefined
}

/**
 * Prepares a Codex launch where the shell function never runs: cmd.exe defines
 * none, and a path-named binary bypasses it. Adds `--no-daemon` when supported
 * and scopes the configured Windows tar shim to that Codex invocation.
 * Everywhere else the function probes the binary the shell itself resolves after
 * the user's startup files, which main cannot see. Null (synchronously) when
 * nothing applies: an extra await tick would reorder the pane-spawn reservation
 * races the spawn handlers arbitrate right after this.
 */
export function planCodexNoDaemonLaunch(launch: LocalCodexLaunch): Promise<string> | null {
  const { command } = launch
  if (!command || !launch.executesOnThisHost) {
    return null
  }
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: false,
      terminalWindowsShell: launch.shellOverride
    }) ?? 'posix'
  const parsed = tokenizeStartupCommand(command, shell)
  const executableSpan = parsed.ok ? parsed.spans[0] : undefined
  if (!parsed.ok || !executableSpan || executableSpan.divergesFromShell) {
    return null
  }
  const [executable, ...args] = parsed.tokens
  if (
    !CODEX_EXECUTABLE.test(pathWin32.basename(executable)) ||
    (shell !== 'cmd' && !isAbsolute(executable))
  ) {
    return null
  }
  const env = { ...process.env, ...launch.env }
  for (const key of launch.envToDelete ?? []) {
    delete env[key]
  }
  const markerKey = CODEX_WINDOWS_TAR_SHIM_DIR_ENV.toLowerCase()
  const markerEntry = Object.entries(launch.env ?? {}).find(
    ([key, value]) => key.toLowerCase() === markerKey && Boolean(value)
  )
  const deletesMarker = launch.envToDelete?.some((key) => key.toLowerCase() === markerKey) === true
  const windowsTarShimDir = markerEntry?.[1]
  const shouldScopeWindowsTar =
    process.platform === 'win32' && Boolean(windowsTarShimDir) && !deletesMarker
  const pathKey = resolvePathEnvKey(launch.env ?? {}, 'win32')
  const effectivePath = launch.env?.[pathKey] ?? process.env[pathKey] ?? ''
  const cmdEnvironmentIsSafe =
    shell !== 'cmd' ||
    (!CMD_ENV_REPARSE_SENSITIVE.test(windowsTarShimDir ?? '') &&
      !CMD_ENV_REPARSE_SENSITIVE.test(effectivePath))
  const posixCommandIsSafe = shell !== 'posix' || !POSIX_REBUILD_SENSITIVE.test(command)
  // Why cmd bytes: its scoped child reparses them even when the original shell kept them quoted.
  const canScopeWindowsTar =
    shouldScopeWindowsTar &&
    !COMMAND_LINE_BREAK.test(command) &&
    parsed.spans.every((span) => !span.divergesFromShell) &&
    cmdEnvironmentIsSafe &&
    posixCommandIsSafe &&
    (shell !== 'cmd' || !CMD_COMMAND_REPARSE_SENSITIVE.test(command))
  const scopeWindowsTar = (value: string, argv: readonly string[]): string => {
    if (!canScopeWindowsTar) {
      return value
    }
    if (shell === 'cmd') {
      return `cmd.exe /d /s /c "set "PATH=%${CODEX_WINDOWS_TAR_SHIM_DIR_ENV}%;%PATH%" & ${value}"`
    }
    if (shell === 'powershell') {
      return `& { $orcaCodexOriginalPath = $env:Path; try { $env:Path = "$env:${CODEX_WINDOWS_TAR_SHIM_DIR_ENV};$env:Path"; ${value} } finally { $env:Path = $orcaCodexOriginalPath } }`
    }
    return buildPosixWindowsTarScopedCommand(argv)
  }
  const skipsNoDaemon =
    env.ORCA_CODEX_ISOLATE === '0' ||
    args.some((arg) => NO_DAEMON_SKIP_ARGS.has(arg) || arg.startsWith('--remote='))
  if (skipsNoDaemon) {
    return canScopeWindowsTar ? Promise.resolve(scopeWindowsTar(command, parsed.tokens)) : null
  }
  return supportsNoDaemon(executable, env, launch.cwd).then((supported) => {
    const argv = supported ? [executable, '--no-daemon', ...args] : parsed.tokens
    return scopeWindowsTar(
      supported
        ? `${command.slice(0, executableSpan.end)} --no-daemon${command.slice(executableSpan.end)}`
        : command,
      argv
    )
  })
}

// Why probe every launch: a cached answer goes stale across an upgrade, and 0.155 and older exit 2 on the flag.
async function supportsNoDaemon(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined
): Promise<boolean> {
  const program = isAbsolute(executable)
    ? executable
    : await resolveCommandOnLocalPath(executable, { env, cwd })
  if (!program) {
    return false
  }
  try {
    const help = await runProcess({
      program,
      args: ['--help'],
      cwd,
      env,
      timeoutMs: HELP_PROBE_TIMEOUT_MS
    })
    return help.stdout.includes('--no-daemon')
  } catch {
    return false
  }
}
