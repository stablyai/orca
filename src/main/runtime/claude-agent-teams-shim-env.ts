import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess,
  isDirectClaudeCommand,
  type ClaudeAgentTeamsMode
} from '../../shared/claude-agent-teams-tmux-compat'
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'

export type ClaudeAgentTeamsLaunchPlan = {
  command: string
  env: Record<string, string>
  envToDelete?: string[]
}

export async function ensureClaudeAgentTeamsShimDir(root = defaultShimRoot()): Promise<string> {
  await mkdir(root, { recursive: true })
  await writeIfChanged(join(root, 'tmux'), unixShimScript())
  if (process.platform === 'win32') {
    await writeIfChanged(join(root, 'tmux.cmd'), windowsShimScript())
    const bundled = resolveBundledTmuxShimPath()
    if (bundled) {
      await copyIfChanged(bundled, join(root, 'tmux.exe'))
    }
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
  if (mode === 'in-process') {
    return {
      command: addClaudeTeammateModeInProcess(args.command),
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    }
  }
  const shimDir = await ensureClaudeAgentTeamsShimDir()
  const shimBin = resolveClaudeAgentTeamsShimBin(args.baseEnv)
  const env = args.createTeamEnv(shimDir, shimBin)
  return {
    command: addClaudeTeammateModeAuto(args.command),
    env,
    envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
  }
}

export function resolveClaudeAgentTeamsShimBin(
  env: Record<string, string | undefined> = process.env
): string {
  if (env.ORCA_AGENT_TEAMS_SHIM_BIN) {
    return env.ORCA_AGENT_TEAMS_SHIM_BIN
  }
  const bundled = bundledLauncherPath()
  if (bundled && isExecutableFile(bundled)) {
    return bundled
  }
  return (
    findExecutableOnPath(process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev', env.PATH) ??
    findExecutableOnPath(getOrcaCliCommandNameForPlatform(process.platform), env.PATH) ??
    getOrcaCliCommandNameForPlatform(process.platform)
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
    if (!directory) {
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

function unixShimScript(): string {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    `exec "\${ORCA_AGENT_TEAMS_SHIM_BIN:-${getOrcaCliCommandNameForPlatform(process.platform)}}" agent-teams-tmux "$@"`,
    ''
  ].join('\n')
}

function windowsShimScript(): string {
  return [
    '@echo off',
    'setlocal',
    'if "%ORCA_AGENT_TEAMS_SHIM_BIN%"=="" (',
    `  set "ORCA_AGENT_TEAMS_SHIM_BIN=${getOrcaCliCommandNameForPlatform(process.platform)}"`,
    ')',
    '"%ORCA_AGENT_TEAMS_SHIM_BIN%" agent-teams-tmux %*',
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

async function copyIfChanged(sourcePath: string, targetPath: string): Promise<boolean> {
  let sourceStat: { size: number; mtimeMs: number }
  try {
    sourceStat = await stat(sourcePath)
  } catch {
    // Source missing — skip silently
    return false
  }
  try {
    const targetStat = await stat(targetPath)
    if (targetStat.size === sourceStat.size && targetStat.mtimeMs === sourceStat.mtimeMs) {
      return false
    }
  } catch {
    // Target missing — copy below
  }
  await mkdir(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  let renamed = false
  try {
    await copyFile(sourcePath, tmp)
    await rename(tmp, targetPath)
    renamed = true
    return true
  } catch (err) {
    console.warn('[claude-agent-teams-shim-env] failed to copy shim:', err)
    return false
  } finally {
    if (!renamed) {
      await rm(tmp, { force: true })
    }
  }
}

function resolveBundledTmuxShimPath(): string | null {
  if (process.resourcesPath) {
    const packaged = join(process.resourcesPath, 'bin', 'agent-teams', 'tmux.exe')
    if (existsSync(packaged)) {
      return packaged
    }
    // resourcesPath was set but the packaged shim is not there — do not fall back to dev
    return null
  }
  const dev = join(process.cwd(), 'native', 'windows-cli-launcher', '.build', 'tmux.exe')
  if (existsSync(dev)) {
    return dev
  }
  return null
}
