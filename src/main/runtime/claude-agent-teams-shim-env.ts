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
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
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
  }
  return root
}

export async function buildClaudeAgentTeamsLaunchPlan(args: {
  command: string | undefined
  mode: ClaudeAgentTeamsMode | undefined
  baseEnv: Record<string, string | undefined>
  createTeamEnv: (shimDir: string, shimBin: string) => Record<string, string>
}): Promise<ClaudeAgentTeamsLaunchPlan | null> {
  const mode = args.mode ?? 'off'
  if (!args.command || mode === 'off' || !isDirectClaudeCommand(args.command)) {
    return null
  }
  if (mode === 'in-process' || process.platform === 'win32') {
    return {
      command: addClaudeTeammateModeInProcess(args.command),
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    }
  }
  const shimBin = resolveClaudeAgentTeamsShimBin(args.baseEnv)
  if (!shimBin) {
    // Refuse cwd-relative CLI resolution when no absolute binary can be found.
    return {
      command: addClaudeTeammateModeInProcess(args.command),
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    }
  }
  const shimDir = await ensureClaudeAgentTeamsShimDir()
  const env = args.createTeamEnv(shimDir, shimBin)
  return {
    command: addClaudeTeammateModeAuto(args.command),
    env,
    envToDelete: ['TERM_PROGRAM']
  }
}

export function resolveClaudeAgentTeamsShimBin(
  env: Record<string, string | undefined> = process.env
): string | null {
  // Windows environments may spell this key Path.
  const pathValue = env[resolvePathEnvKey(env, process.platform)]
  const rawOverride = env.ORCA_AGENT_TEAMS_SHIM_BIN
  // Qualify bare overrides before the shim shell can resolve them against its cwd.
  const override = rawOverride
    ? isAbsolute(rawOverride)
      ? rawOverride
      : findExecutableOnPath(rawOverride, pathValue)
    : null
  // Inherited team overrides may point at an older leader’s stale GUI binary.
  const inheritedFromTeam = Boolean(env.ORCA_AGENT_TEAMS_TEAM_ID)
  if (override && !inheritedFromTeam) {
    return override
  }
  // Headless hosts lack resourcesPath; prefer their launcher before PATH can select AppImage’s GUI binary.
  const hostLauncher = hasAppEnvironment() ? getAppEnvironment().getCliLauncherPath?.() : null
  if (hostLauncher && isAbsolute(hostLauncher) && isExecutableFile(hostLauncher)) {
    return hostLauncher
  }
  const bundled = process.resourcesPath
    ? getBundledLauncherPath(process.platform, process.resourcesPath)
    : null
  if (bundled && isExecutableFile(bundled)) {
    return bundled
  }
  if (override) {
    return override
  }
  return (
    findExecutableOnPath(process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev', pathValue) ??
    findExecutableOnPath(getOrcaCliCommandNameForPlatform(process.platform), pathValue)
  )
}

function defaultShimRoot(): string {
  return join(homedir(), '.orca', 'claude-agent-teams-bin')
}

function findExecutableOnPath(command: string, pathValue: string | undefined): string | null {
  for (const directory of pathValue?.split(delimiter) ?? []) {
    // Empty/relative PATH entries could execute a cwd-planted binary with the team token.
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

// Require an absolute CLI: cmd.exe and POSIX dot/empty PATH entries can execute a cwd-planted orca with the team token.
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
    // call would percent-expand tmux pane ids such as %2 again.
    '"%ORCA_SHIM_BIN%" agent-teams-tmux %*',
    'exit /b %ERRORLEVEL%',
    ':unqualified',
    'echo orca agent-teams tmux shim: ORCA_AGENT_TEAMS_SHIM_BIN must be an absolute path 1>&2',
    'exit /b 127',
    ''
  ].join('\r\n')
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === content) {
      return
    }
  } catch {
    // Missing/unreadable shims are replaced below.
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
