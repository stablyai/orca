import { isAbsolute, win32 as pathWin32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { CODEX_NO_DAEMON_SKIP_ARGS } from '../../shared/codex-shell-function'

const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i
const NO_DAEMON_SKIP_ARGS: ReadonlySet<string> = new Set(CODEX_NO_DAEMON_SKIP_ARGS)
// A hung capability probe must not block pane creation indefinitely.
const HELP_PROBE_TIMEOUT_MS = 5_000

export type LocalCodexLaunch = {
  command: string | undefined
  /** False for SSH and WSL spawns: their shell's codex function probes on that host. */
  executesOnThisHost: boolean
  /** Shell the provider will launch; undefined means the platform default. */
  shellOverride: string | undefined
  /** Overrides inherited process env. */
  env: Record<string, string | undefined> | undefined
  /** Removed after env overrides are merged. */
  envToDelete?: readonly string[]
  cwd: string | undefined
}

/** Add --no-daemon where shell functions cannot: cmd.exe or an absolute Codex path.
 * Other shells probe after user startup files; synchronous null preserves spawn-reservation ordering. */
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
  if (
    env.ORCA_CODEX_ISOLATE === '0' ||
    args.some((arg) => NO_DAEMON_SKIP_ARGS.has(arg) || arg.startsWith('--remote='))
  ) {
    return null
  }
  return supportsNoDaemon(executable, env, launch.cwd).then((supported) =>
    supported
      ? `${command.slice(0, executableSpan.end)} --no-daemon${command.slice(executableSpan.end)}`
      : command
  )
}

// Reprobe after possible upgrades; older Codex versions reject the flag.
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
