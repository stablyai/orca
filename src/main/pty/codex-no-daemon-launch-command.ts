import { isAbsolute, win32 as pathWin32 } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { quoteStartupArg, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { CODEX_SHARED_SERVER_ARGS, codexArgsOverrideHooks } from '../../shared/codex-shell-function'
import {
  codexHookFlagTableExists,
  readCodexHookFlagEntry,
  resolveCodexProbePath,
  type CodexHookFlagEntry
} from '../codex/codex-hook-flag-table'
import { codexHomeHoldsOrcaFileEntry } from '../codex/codex-hook-file-entry-probe'
import { syncCodexHookFlags } from '../codex/codex-hook-flag-sync'

const CODEX_EXECUTABLE = /^codex(\.(exe|cmd|bat|ps1))?$/i
const SHARED_SERVER_ARGS: ReadonlySet<string> = new Set(CODEX_SHARED_SERVER_ARGS)
// Why bounded: a hung binary must not hold the pane; a slow probe only costs the flag.
const HELP_PROBE_TIMEOUT_MS = 5_000

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
  /** Orca's flag table; its entry is carried only by a launch no codex function sees. */
  hookFlagTable?: string | null
  /** The pane's CODEX_HOME; null for the user's default home. */
  codexHomePath?: string | null
}

/**
 * The launch command with `--no-daemon` after the Codex executable, applying the
 * shell codex function's rule (src/shared/codex-shell-function.ts) where that
 * function never runs: cmd.exe defines none, and a path-named binary bypasses it.
 * Those launches also get the function's status hook flag, from the table entry
 * for their binary's version, under the same gates.
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
  // Why the existence check: no table means Codex hooks are off, so nothing is probed.
  const hookFlagTable =
    (shell === 'cmd' || isAbsolute(executable)) &&
    launch.hookFlagTable &&
    codexHookFlagTableExists(launch.hookFlagTable)
      ? launch.hookFlagTable
      : null
  const sharedServer =
    env.ORCA_CODEX_ISOLATE === '0' ||
    args.some((arg) => SHARED_SERVER_ARGS.has(arg) || arg.startsWith('--remote='))
  if (sharedServer && !hookFlagTable) {
    return null
  }
  const head = command.slice(0, executableSpan.end)
  const tail = command.slice(executableSpan.end)
  const codexHomePath = launch.codexHomePath ?? env.CODEX_HOME
  return (async () => {
    const entry = hookFlagTable
      ? await readHookFlagEntryFor(executable, hookFlagTable, env, launch.cwd)
      : null
    // Why skip beside the user's own `-c hooks...`: it replaces Orca's table, approval included.
    const hookFlag =
      entry && !codexArgsOverrideHooks(args) && !codexHomeHoldsOrcaFileEntry(codexHomePath)
        ? entry.flag
        : null
    const noDaemon = sharedServer
      ? false
      : (entry?.noDaemon ?? (await supportsNoDaemon(executable, env, launch.cwd)))
    const hookArg = hookFlag ? ` -c ${quoteHookFlag(hookFlag, shell)}` : ''
    return `${head}${noDaemon ? ' --no-daemon' : ''}${hookArg}${tail}`
  })()
}

function quoteHookFlag(flag: string, shell: 'posix' | 'powershell' | 'cmd'): string {
  // Why plain quotes for cmd: the Windows flag never holds `"` or `%`, and a caret inside quotes is literal.
  return shell === 'cmd' ? `"${flag}"` : quoteStartupArg(flag, shell)
}

/** The table entry for the version this binary reports; a miss syncs for this binary. */
async function readHookFlagEntryFor(
  executable: string,
  table: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined
): Promise<CodexHookFlagEntry | null> {
  const program = await resolveCodexProgram(executable, env, cwd)
  if (!program) {
    return null
  }
  let lines: string[] = []
  try {
    const version = await runProcess({
      program,
      args: ['--version'],
      cwd,
      env,
      timeoutMs: HELP_PROBE_TIMEOUT_MS
    })
    lines = version.code === 0 ? version.stdout.split(/\r?\n/).map((line) => line.trim()) : []
  } catch {
    return null
  }
  // Why line by line: a cmd AutoRun under npm's codex.cmd can print before Codex's own line.
  const versions = lines.filter(Boolean)
  for (const codexVersion of versions) {
    const entry = readCodexHookFlagEntry(codexVersion, table)
    if (entry) {
      return entry
    }
  }
  // Why: Orca derives this binary's entry, so a later launch carries it.
  if (versions.length > 0) {
    void syncCodexHookFlags({ codexPath: program })
  }
  return null
}

// Why probe unless the table records it: a cached answer goes stale across an upgrade, and 0.155 and older exit 2 on the flag.
async function supportsNoDaemon(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined
): Promise<boolean> {
  const program = await resolveCodexProgram(executable, env, cwd)
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

// Why resolved for cmd's bare `codex`: the probe and its table entry must name the binary cmd.exe runs.
async function resolveCodexProgram(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined
): Promise<string | null> {
  return isAbsolute(executable)
    ? resolveCodexProbePath(executable)
    : await resolveCommandOnLocalPath(executable, { env, cwd })
}
