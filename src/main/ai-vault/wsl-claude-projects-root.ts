import { stat } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import type { AiVaultScanOptions } from './session-scanner-types'

type DirectoryExists = (path: string) => Promise<boolean>
type ReadRealpath = (distro: string, linuxPath: string) => Promise<string | null>

export type WslClaudeProjectsResolution = {
  rootDir: string | null
  issue: { path: string; message: string } | null
}

// An unreadable symlink target is retried next scan. A resolved directory, or a home that is
// not a different symlink, stays for this process so later scans do not call wsl.exe again.
const resolvedCache = new Map<string, WslClaudeProjectsResolution>()

export function resetWslClaudeProjectsRootCacheForTests(): void {
  resolvedCache.clear()
}

export function claudeProjectsDirForWslHome(homeDir: string): string {
  // UNC homes must stay Windows paths even when this module is tested on POSIX.
  return parseWslUncPath(homeDir)
    ? pathWin32.join(homeDir, '.claude', 'projects')
    : join(homeDir, '.claude', 'projects')
}

export async function extraWslClaudeProjectsDirs(
  options: Pick<AiVaultScanOptions, 'wslHomeDirs' | 'platform' | 'resolveWslClaudeProjectsDir'>
): Promise<{ dirs: string[]; issues: AiVaultScanIssue[] }> {
  const dirs: string[] = []
  const issues: AiVaultScanIssue[] = []
  for (const homeDir of options.wslHomeDirs ?? []) {
    if (options.resolveWslClaudeProjectsDir) {
      const resolved = await options.resolveWslClaudeProjectsDir(homeDir)
      if (resolved) {
        dirs.push(resolved)
      }
      continue
    }
    const found = await resolveWslClaudeProjectsDir({ homeDir, platform: options.platform })
    if (found.rootDir) {
      dirs.push(found.rootDir)
    }
    if (found.issue) {
      issues.push({ agent: 'claude', path: found.issue.path, message: found.issue.message })
    }
  }
  return { dirs, issues }
}

// Why: the 9p share does not follow a WSL symlink, so ~/.claude -> ~/dotfiles/.claude
// looks absent to Windows and the history scan reports no Claude rows and no issue.
export async function resolveWslClaudeProjectsDir(args: {
  homeDir: string
  platform?: NodeJS.Platform
  directoryExists?: DirectoryExists
  readRealpath?: ReadRealpath
  // Tests set this to observe the process cache while injecting the reader.
  useProcessCache?: boolean
}): Promise<WslClaudeProjectsResolution> {
  const parsed = parseWslUncPath(args.homeDir)
  if (!parsed) {
    return { rootDir: null, issue: null }
  }
  const readRealpath = args.readRealpath
  const platform = args.platform ?? process.platform
  if (platform !== 'win32' && !readRealpath) {
    return { rootDir: null, issue: null }
  }
  const exists = args.directoryExists ?? directoryExists
  const direct = claudeProjectsDirForWslHome(args.homeDir)
  // A real directory at the logical path wins over a previously cached symlink target.
  if (await exists(direct)) {
    return { rootDir: null, issue: null }
  }
  const useCache =
    args.useProcessCache ?? (args.directoryExists === undefined && args.readRealpath === undefined)
  if (useCache) {
    const cached = resolvedCache.get(args.homeDir)
    if (cached) {
      return cached
    }
  }
  const linuxPath = `${parsed.linuxPath.replace(/\/$/, '')}/.claude/projects`
  const real = await (readRealpath ?? defaultReadRealpath)(parsed.distro, linuxPath)
  const result = await resolutionForRealpath({
    direct,
    distro: parsed.distro,
    linuxPath,
    real,
    exists
  })
  if (useCache && !result.issue) {
    resolvedCache.set(args.homeDir, result)
  }
  return result
}

async function resolutionForRealpath(args: {
  direct: string
  distro: string
  linuxPath: string
  real: string | null
  exists: DirectoryExists
}): Promise<WslClaudeProjectsResolution> {
  const real = canonicalLinuxPath(args.real)
  if (!real || !real.startsWith('/') || real === args.linuxPath) {
    return { rootDir: null, issue: null }
  }
  const rootDir = toWindowsWslPath(real, args.distro)
  if (rootDir === args.direct || (await args.exists(rootDir))) {
    return { rootDir: rootDir === args.direct ? null : rootDir, issue: null }
  }
  return {
    rootDir: null,
    issue: {
      path: args.direct,
      message:
        'WSL ~/.claude is a symlink Windows cannot follow, and the resolved projects directory is not readable.'
    }
  }
}

function canonicalLinuxPath(path: string | null): string | null {
  if (!path || path === '/') {
    return path
  }
  return path.replace(/\/+$/, '')
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function defaultReadRealpath(distro: string, linuxPath: string): Promise<string | null> {
  try {
    const { runWslExe } = await import('../wsl/execution/wsl-exe-process')
    const stdout = await runWslExe([
      '-d',
      distro,
      '--',
      'sh',
      '-c',
      'if [ ! -d "$1" ]; then exit 2; fi; readlink -f -- "$1"',
      'sh',
      linuxPath
    ])
    const value = stdout.trim()
    return value.startsWith('/') ? value : null
  } catch {
    return null
  }
}
