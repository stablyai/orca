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
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'
import { resolvePathEnvKey } from '../pty/windows-path-segment-merge'
import type { ClaudeAgentTeamsIt2Shim } from './claude-agent-teams-types'

const IT2_PROBE_SHELL_NAME = 'orca-agent-teams-probe-shell'

export type ClaudeAgentTeamsLaunchPlan = {
  command: string
  env: Record<string, string>
  envToDelete?: string[]
}

export async function ensureClaudeAgentTeamsShimDir(root = defaultShimRoot()): Promise<string> {
  await mkdir(root, { recursive: true })
  await writeIfChanged(join(root, 'tmux'), unixShimScript('tmux'))
  if (process.platform === 'win32') {
    await writeIfChanged(join(root, 'tmux.cmd'), windowsClaudeAgentTeamsShimScript())
  }
  return root
}

/** Separate from the tmux shim dir so `it2` is on PATH only for the leader that asked for iTerm2 mode. */
export async function ensureClaudeAgentTeamsIt2ShimDir(
  root = defaultIt2ShimRoot()
): Promise<ClaudeAgentTeamsIt2Shim | null> {
  if (process.platform === 'win32') {
    return null
  }
  await mkdir(root, { recursive: true })
  const probeShell = join(root, IT2_PROBE_SHELL_NAME)
  await writeIfChanged(join(root, 'it2'), unixShimScript('it2'))
  await writeIfChanged(probeShell, it2ProbeShellScript())
  return { shimDir: root, probeShell }
}

export async function buildClaudeAgentTeamsLaunchPlan(args: {
  command: string | undefined
  mode: ClaudeAgentTeamsMode | undefined
  teammateMode?: 'iterm2'
  baseEnv: Record<string, string | undefined>
  createTeamEnv: (
    shimDir: string,
    shimBin: string,
    it2?: ClaudeAgentTeamsIt2Shim
  ) => Record<string, string>
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
    // Why: without an absolute CLI path the shim would resolve a bare `orca` against the pane cwd, so degrade instead.
    return {
      command: addClaudeTeammateModeInProcess(args.command),
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    }
  }
  const shimDir = await ensureClaudeAgentTeamsShimDir()
  const it2 = args.teammateMode === 'iterm2' ? await ensureClaudeAgentTeamsIt2ShimDir() : null
  const env = it2 ? args.createTeamEnv(shimDir, shimBin, it2) : args.createTeamEnv(shimDir, shimBin)
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

function defaultIt2ShimRoot(): string {
  return join(homedir(), '.orca', 'claude-agent-teams-it2-bin')
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
function unixShimScript(name: 'tmux' | 'it2'): string {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'orca_bin=${ORCA_AGENT_TEAMS_SHIM_BIN:-}',
    'case $orca_bin in',
    '  /*|[A-Za-z]:[\\\\/]*) ;;',
    '  *)',
    `    echo "orca agent-teams ${name} shim: ORCA_AGENT_TEAMS_SHIM_BIN must be an absolute path" >&2`,
    '    exit 127',
    '    ;;',
    'esac',
    `exec "$orca_bin" agent-teams-${name} "$@"`,
    ''
  ].join('\n')
}

// Why: Claude finds `it2` via `$SHELL -lc 'command -v it2'`, and login rc files can reorder PATH past the shim dir,
// so SHELL points here; every other invocation must reach the user's real shell untouched.
function it2ProbeShellScript(): string {
  return [
    '#!/bin/sh',
    'if [ "$#" -eq 2 ] && [ "$1" = "-lc" ] && [ "$2" = "command -v it2" ] && [ -n "${ORCA_AGENT_TEAMS_IT2_SHIM_DIR:-}" ]; then',
    '  printf \'%s\\n\' "$ORCA_AGENT_TEAMS_IT2_SHIM_DIR/it2"',
    '  exit 0',
    'fi',
    'real=${ORCA_AGENT_TEAMS_REAL_SHELL:-/bin/zsh}',
    // Why: a real shell that resolves back to this wrapper would exec itself forever.
    'case $real in',
    `  */${IT2_PROBE_SHELL_NAME}) real=/bin/sh ;;`,
    'esac',
    '[ -x "$real" ] || real=/bin/sh',
    'exec "$real" "$@"',
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

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === content) {
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
