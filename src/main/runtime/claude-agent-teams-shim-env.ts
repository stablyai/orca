import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import {
  isDirectClaudeCommand,
  setClaudeTeammateMode,
  type ClaudeAgentTeamsMode
} from '../../shared/claude-agent-teams-mode'
import { supportsClaudeAgentTeamsPaneShell } from '../../shared/claude-agent-teams-pane-launch'
import { resolveStartupShell, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'
import { resolvePathEnvKey } from '../pty/windows-path-segment-merge'

export type ClaudeAgentTeamsLaunchPlan = {
  mode: 'native' | 'in-process'
  command: string
  env: Record<string, string>
  envToDelete?: string[]
}

export type ClaudeAgentTeamsShimTarget = {
  shimDir: string
  shimBin: string
  env: Record<string, string>
}

const shimInstallations = new Map<string, Promise<string>>()

export function ensureClaudeAgentTeamsShimDir(
  root = defaultShimRoot(),
  windowsLauncher?: Buffer
): Promise<string> {
  const existing = shimInstallations.get(root)
  if (existing) {
    return existing
  }
  const installation = materializeClaudeAgentTeamsShimDir(root, windowsLauncher).finally(() => {
    if (shimInstallations.get(root) === installation) {
      shimInstallations.delete(root)
    }
  })
  shimInstallations.set(root, installation)
  return installation
}

async function materializeClaudeAgentTeamsShimDir(
  root: string,
  windowsLauncher?: Buffer
): Promise<string> {
  await mkdir(root, { recursive: true })
  await writeIfChanged(join(root, 'tmux'), unixShimScript())
  if (process.platform === 'win32') {
    await writeIfChanged(join(root, 'tmux.cmd'), windowsClaudeAgentTeamsShimScript())
    await installWindowsShimExecutable(root, windowsLauncher)
  }
  return root
}

export function windowsClaudeAgentTeamsShimExecutablePath(root = defaultShimRoot()): string {
  return join(root, 'tmux.exe')
}

async function installWindowsShimExecutable(root: string, launcherBytes?: Buffer): Promise<void> {
  if (launcherBytes) {
    await writeIfChanged(windowsClaudeAgentTeamsShimExecutablePath(root), launcherBytes)
    return
  }
  const launcher = windowsShimLauncherSource()
  if (!launcher || !isExecutableFile(launcher)) {
    return
  }
  await writeIfChanged(windowsClaudeAgentTeamsShimExecutablePath(root), await readFile(launcher))
}

export async function buildClaudeAgentTeamsLaunchPlan(args: {
  command: string | undefined
  mode: ClaudeAgentTeamsMode | undefined
  baseEnv: Record<string, string | undefined>
  paneShell?: AgentStartupShell
  executionPlatform: NodeJS.Platform
  isRemote: boolean
  shimRoot?: string
  prepareShimTarget?: typeof prepareClaudeAgentTeamsShimTarget
  createTeamEnv: (
    shimDir: string,
    shimBin: string,
    shimEnv: Record<string, string>
  ) => Record<string, string>
}): Promise<ClaudeAgentTeamsLaunchPlan | null> {
  const mode = args.mode ?? 'off'
  const paneShell = resolveStartupShell(args.executionPlatform, args.paneShell)
  if (!args.command || mode === 'off' || !isDirectClaudeCommand(args.command, paneShell)) {
    return null
  }
  const inProcess = {
    mode: 'in-process' as const,
    command: setClaudeTeammateMode(args.command, 'in-process', paneShell),
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
  }
  if (
    mode === 'in-process' ||
    // Why: Windows shell fallback is known only after spawn; explicit `orca claude-teams` upgrades after publication.
    process.platform === 'win32' ||
    !supportsClaudeAgentTeamsPaneShell(paneShell)
  ) {
    return inProcess
  }
  const prepareShimTarget = args.prepareShimTarget ?? prepareClaudeAgentTeamsShimTarget
  const target = await prepareShimTarget(args.baseEnv, args.shimRoot)
  if (!target) {
    // Why: without an absolute CLI path the shim would resolve a bare `orca` against the pane cwd, so degrade instead.
    return inProcess
  }
  const env = args.createTeamEnv(target.shimDir, target.shimBin, target.env)
  return {
    mode: 'native',
    command: setClaudeTeammateMode(args.command, 'auto', paneShell),
    env,
    envToDelete: ['TERM_PROGRAM']
  }
}

export async function prepareClaudeAgentTeamsShimTarget(
  baseEnv: Record<string, string | undefined>,
  shimRoot = defaultShimRoot(),
  readWindowsLauncher: (path: string) => Promise<Buffer> = (path) => readFile(path)
): Promise<ClaudeAgentTeamsShimTarget | null> {
  const shimBin = resolveClaudeAgentTeamsShimBin(baseEnv)
  if (!shimBin) {
    return null
  }
  let installRoot = shimRoot
  let windowsLauncher: Buffer | undefined
  if (process.platform === 'win32') {
    const launcher = windowsShimLauncherSource()
    if (!launcher || !isExecutableFile(launcher)) {
      return null
    }
    windowsLauncher = await readWindowsLauncher(launcher)
    installRoot = windowsClaudeAgentTeamsVersionedShimRoot(shimRoot, windowsLauncher)
  }
  const shimDir = await ensureClaudeAgentTeamsShimDir(installRoot, windowsLauncher)
  if (process.platform !== 'win32') {
    return { shimDir, shimBin, env: {} }
  }
  if (!isExecutableFile(windowsClaudeAgentTeamsShimExecutablePath(shimDir))) {
    return null
  }
  const devCliEntry = developmentCliEntryPath()
  if (devCliEntry) {
    return {
      shimDir,
      shimBin,
      env: {
        ORCA_AGENT_TEAMS_SHIM_EXECUTABLE: process.execPath,
        ORCA_AGENT_TEAMS_SHIM_CLI_ENTRY: devCliEntry
      }
    }
  }
  return shimBin.toLowerCase().endsWith('.exe') ? { shimDir, shimBin, env: {} } : null
}

export function windowsClaudeAgentTeamsVersionedShimRoot(
  root: string,
  launcher: Uint8Array
): string {
  const launcherHash = createHash('sha256').update(launcher).digest('hex')
  return join(root, `launcher-${launcherHash.slice(0, 16)}`)
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

function developmentCliEntryPath(): string | null {
  const repoRoot = process.env.ORCA_DEV_REPO_ROOT
  if (!repoRoot) {
    return null
  }
  const candidate = join(repoRoot, 'out', 'cli', 'index.js')
  return existsSync(candidate) ? candidate : null
}

function windowsShimLauncherSource(): string | null {
  const bundled = bundledLauncherPath()
  if (bundled && existsSync(bundled)) {
    return bundled
  }
  const repoRoot = process.env.ORCA_DEV_REPO_ROOT
  if (!repoRoot) {
    return null
  }
  const candidate = join(repoRoot, 'native', 'windows-cli-launcher', '.build', 'orca.exe')
  return existsSync(candidate) ? candidate : null
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
    const existing = await readFile(path)
    if (
      typeof content === 'string' ? existing.toString('utf8') === content : existing.equals(content)
    ) {
      return
    }
  } catch {
    // rewrite below
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  let renamed = false
  try {
    await writeFile(tmp, content)
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
