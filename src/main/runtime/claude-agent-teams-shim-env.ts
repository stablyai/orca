import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess,
  isDirectClaudeCommand,
  type ClaudeAgentTeamsMode
} from '../../shared/claude-agent-teams-tmux-compat'
import { supportsClaudeAgentTeamsPaneCommand } from '../../shared/claude-agent-teams-pane-command'
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import { resolvePathEnvKey } from '../pty/windows-path-segment-merge'

export type ClaudeAgentTeamsLaunchPlan = {
  command: string
  env: Record<string, string>
  envToDelete?: string[]
}

export async function ensureClaudeAgentTeamsShimDir(root = defaultShimRoot()): Promise<string> {
  await mkdir(root, { recursive: true })
  await writeIfChanged(join(root, 'tmux'), unixShimScript())
  if (process.platform === 'win32') {
    await writeIfChanged(join(root, 'tmux.cmd'), windowsClaudeAgentTeamsShimScript())
    await installWindowsShimExecutable(root)
  }
  return root
}

/** Path of the Windows shim Claude Code can actually spawn; see installWindowsShimExecutable. */
export function windowsClaudeAgentTeamsShimExecutablePath(root = defaultShimRoot()): string {
  return join(root, 'tmux.exe')
}

/**
 * Claude Code spawns `tmux` with no shell, and Node refuses to spawn `.cmd`
 * without one (CVE-2024-27980), so `tmux.cmd` alone is unreachable — the spawn
 * fails with EINVAL before the shim runs. The packaged launcher is a
 * self-contained .NET Framework executable that already forwards argv to the
 * Orca CLI, and it switches to tmux-shim mode when its own file name is `tmux`,
 * so a copy of it under that name is the shim.
 */
async function installWindowsShimExecutable(root: string): Promise<void> {
  const launcher = bundledLauncherPath()
  if (!launcher || !isExecutableFile(launcher)) {
    return
  }
  await writeIfChanged(windowsClaudeAgentTeamsShimExecutablePath(root), await readFile(launcher))
}

export async function buildClaudeAgentTeamsLaunchPlan(args: {
  command: string | undefined
  mode: ClaudeAgentTeamsMode | undefined
  baseEnv: Record<string, string | undefined>
  /** Shell the panes type into; decides whether Orca can spell the teammate command. */
  paneShell?: AgentStartupShell
  shimRoot?: string
  createTeamEnv: (shimDir: string, shimBin: string) => Record<string, string>
}): Promise<ClaudeAgentTeamsLaunchPlan | null> {
  const mode = args.mode ?? 'off'
  if (!args.command || mode === 'off' || !isDirectClaudeCommand(args.command)) {
    return null
  }
  const inProcess: ClaudeAgentTeamsLaunchPlan = {
    command: addClaudeTeammateModeInProcess(args.command),
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
  }
  // Why: Claude Code writes pane commands for sh, and cmd.exe is the one pane shell Orca cannot re-spell them for.
  if (
    mode === 'in-process' ||
    !supportsClaudeAgentTeamsPaneCommand(resolveStartupShell(process.platform, args.paneShell))
  ) {
    return inProcess
  }
  const shimBin = resolveClaudeAgentTeamsShimBin(args.baseEnv)
  if (!shimBin) {
    // Why: without an absolute CLI path the shim would resolve a bare `orca` against the pane cwd, so degrade instead.
    return inProcess
  }
  const shimDir = await ensureClaudeAgentTeamsShimDir(args.shimRoot ?? defaultShimRoot())
  // Why: the .cmd shim is unspawnable from Claude Code, so without the executable the team would launch paneless.
  if (
    process.platform === 'win32' &&
    !isExecutableFile(windowsClaudeAgentTeamsShimExecutablePath(shimDir))
  ) {
    return inProcess
  }
  const env = args.createTeamEnv(shimDir, shimBin)
  return {
    command: addClaudeTeammateModeAuto(args.command),
    env,
    envToDelete: ['TERM_PROGRAM']
  }
}

/** Absolute path to the Orca CLI that backs the tmux shim, or null when none can be qualified. */
export function resolveClaudeAgentTeamsShimBin(
  env: Record<string, string | undefined> = process.env
): string | null {
  // Why: Windows callers pass an env spelt `Path`; reading only `PATH` there would find no CLI at all.
  const pathValue = env[resolvePathEnvKey(env, process.platform)]
  const override = env.ORCA_AGENT_TEAMS_SHIM_BIN
  if (override) {
    // Why: a bare override name would be resolved by the shim's shell against its cwd, so qualify it or ignore it.
    const qualified = isAbsolute(override) ? override : findExecutableOnPath(override, pathValue)
    if (qualified) {
      return qualified
    }
  }
  const bundled = bundledLauncherPath()
  if (bundled && isExecutableFile(bundled)) {
    return bundled
  }
  return (
    findExecutableOnPath(process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev', pathValue) ??
    findExecutableOnPath(getOrcaCliCommandNameForPlatform(process.platform), pathValue)
  )
}

function defaultShimRoot(): string {
  return join(homedir(), '.orca', 'claude-agent-teams-bin')
}

function bundledLauncherPath(): string | null {
  if (!process.resourcesPath) {
    return null
  }
  if (process.platform === 'darwin') {
    return join(process.resourcesPath, 'bin', 'orca')
  }
  if (process.platform === 'linux') {
    return join(process.resourcesPath, 'bin', 'orca-ide')
  }
  if (process.platform === 'win32') {
    return join(process.resourcesPath, 'bin', 'orca.exe')
  }
  return null
}

function findExecutableOnPath(command: string, pathValue: string | undefined): string | null {
  for (const directory of pathValue?.split(delimiter) ?? []) {
    // Why: empty and relative PATH entries resolve against a cwd we do not control, which is the hijack we are avoiding.
    if (!directory || !isAbsolute(directory)) {
      continue
    }
    const candidate = join(directory, command)
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return null
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate)) {
      return false
    }
    accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Why: an unqualified command name is resolved against the invoking pane's cwd (always on cmd.exe, and via `.`/empty
// PATH entries on POSIX), so a stray `orca` next to the agent's files would run with the team token. Demand a
// fully-qualified binary instead of guessing one.
function unixShimScript(): string {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'orca_bin=${ORCA_AGENT_TEAMS_SHIM_BIN:-}',
    'case $orca_bin in',
    '  /*|[A-Za-z]:[\\\\/]*) ;;',
    '  *)',
    '    echo "orca agent-teams tmux shim: ORCA_AGENT_TEAMS_SHIM_BIN must be an absolute path" >&2',
    '    exit 127',
    '    ;;',
    'esac',
    'exec "$orca_bin" agent-teams-tmux "$@"',
    ''
  ].join('\n')
}

export function windowsClaudeAgentTeamsShimScript(): string {
  return [
    '@echo off',
    'setlocal',
    'set "ORCA_SHIM_BIN=%ORCA_AGENT_TEAMS_SHIM_BIN%"',
    'if not defined ORCA_SHIM_BIN goto :unqualified',
    'if "%ORCA_SHIM_BIN:~1,1%"==":" goto :run',
    'if "%ORCA_SHIM_BIN:~0,2%"=="\\\\" goto :run',
    'goto :unqualified',
    ':run',
    // Why: no `call` — its extra percent-expansion pass would rewrite tmux pane args such as `%2` into batch parameters.
    '"%ORCA_SHIM_BIN%" agent-teams-tmux %*',
    'exit /b %ERRORLEVEL%',
    ':unqualified',
    'echo orca agent-teams tmux shim: ORCA_AGENT_TEAMS_SHIM_BIN must be an absolute path 1>&2',
    'exit /b 127',
    ''
  ].join('\r\n')
}

async function writeIfChanged(path: string, content: string | Buffer): Promise<void> {
  try {
    if (typeof content === 'string') {
      if ((await readFile(path, 'utf8')) === content) {
        return
      }
    } else if (content.equals(await readFile(path))) {
      return
    }
  } catch {
    // rewrite below
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  let renamed = false
  try {
    await writeFile(tmp, content, 'utf8')
    if (process.platform !== 'win32') {
      await chmod(tmp, 0o755)
    }
    await rename(tmp, path)
    renamed = true
  } finally {
    if (!renamed) {
      await rm(tmp, { force: true })
    }
  }
}
