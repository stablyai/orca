import { isAbsolute, win32 as pathWin32 } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { CODEX_SHARED_SERVER_ARGS } from '../../shared/codex-shell-function'

const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i
const SHARED_SERVER_ARGS: ReadonlySet<string> = new Set(CODEX_SHARED_SERVER_ARGS)
// Why bounded: a hung binary must not hold the pane; a slow probe only costs the flag.
const HELP_PROBE_TIMEOUT_MS = 5_000

export type LocalCodexLaunch = {
  trustedExecutable?: string
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
 * The launch command with `--no-daemon` after the Codex executable, applying the
 * shell codex function's rule (src/shared/codex-shell-function.ts) where that
 * function never runs: cmd.exe defines none, and a path-named binary bypasses it.
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
    (executable !== launch.trustedExecutable &&
      !CODEX_EXECUTABLE.test(pathWin32.basename(executable))) ||
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
    args.some((arg) => SHARED_SERVER_ARGS.has(arg) || arg.startsWith('--remote='))
  ) {
    return null
  }
  return supportsNoDaemon(executable, env, launch.cwd).then((supported) =>
    supported
      ? `${command.slice(0, executableSpan.end)} --no-daemon${command.slice(executableSpan.end)}`
      : command
  )
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
