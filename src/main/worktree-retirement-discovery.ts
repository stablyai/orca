import { claudeProfileHistoryDirs } from './claude-accounts/claude-profile-installed-router'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isWslUncPath, parseWslUncPath } from '../shared/wsl-paths'
import {
  encodeClaudeProjectPaths,
  isClaudeProjectDirInScope
} from './ai-vault/claude-project-dir-encoding'
import { wslGatedReaddir, wslGatedStat } from './native-chat/wsl-transcript-fs-access'
import type { RetirementScanResult } from './worktree-retirement-backfill-scan'
import { normalizeRetirableGeneratedName } from './worktree-name-retirement'
import { getWslHomeAsync } from './wsl'

/** Prefer spending an extra name to reissuing a path whose agent history survives. */
export function collectRetiredNamesFromLeafNames(leafNames: Iterable<string>): Set<string> {
  const retired = new Set<string>()
  for (const leafName of leafNames) {
    if (typeof leafName !== 'string' || leafName.length === 0) {
      continue
    }
    const normalized = normalizeRetirableGeneratedName(leafName)
    if (normalized) {
      retired.add(normalized)
    }
  }
  return retired
}

/** Strip the encoded parent before extracting leaves; trailing-dash parsing can retire a numeric workspace's parent. */
export function extractBucketLeafCandidates(
  bucketName: string,
  encodedParents: readonly string[]
): string[] {
  const bucket = bucketName.toLowerCase()
  for (const parent of encodedParents) {
    if (!parent || bucket === parent || !isClaudeProjectDirInScope(bucket, [parent])) {
      continue
    }
    const remainder = bucket.slice(parent.length + 1)
    if (!remainder) {
      continue
    }
    const firstSegment = remainder.split('-')[0]
    return remainder === firstSegment ? [remainder] : [remainder, firstSegment]
  }
  return []
}

/** Share WSL scan admission/deadlines; report refusals without discarding names readable from other sources. */
async function readDirectoryNames(path: string): Promise<{ names: string[]; refused: boolean }> {
  try {
    const entries = await wslGatedReaddir(path, 'scan')
    return {
      names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      refused: false
    }
  } catch (error) {
    // Missing directories are complete answers; other failures leave unread names and must remain retryable.
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { names: [], refused: true }
    }
    return { names: [], refused: isWslUncPath(path) && !(await uncRouteIsReachable(path)) }
  }
}

/** UNC ENOENT can mean an unreachable distro; a reachable ancestor proves actual absence. */
async function uncRouteIsReachable(path: string): Promise<boolean> {
  let current = path
  // Stat ancestors instead of listing homes over 9P; bound the walk to avoid holding admission indefinitely.
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = current.replace(/[/\\]+[^/\\]+[/\\]*$/, '')
    if (!parent || parent === current || !isWslUncPath(parent)) {
      return false
    }
    try {
      await wslGatedStat(parent, 'scan')
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return false
      }
      current = parent
    }
  }
  return false
}

/** Scan Claude directory names; Codex backfill would require reading conversation contents and is intentionally omitted. */
function getClaudeProjectsDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return override ? join(override, 'projects') : join(home, '.claude', 'projects')
}

type ClaudeProjectsSource = {
  projectsDir: string
  encodedParents: string[]
}

// Fold both sides for case-insensitive filesystems; missed buckets risk reissuing used paths.
function encodeParents(paths: readonly string[]): string[] {
  return paths
    .filter((path) => path.length > 0)
    .flatMap((path) => encodeClaudeProjectPaths(path).map((encoded) => encoded.toLowerCase()))
}

/** WSL agents leave buckets in the distro home; only its default location is visible, not distro CLAUDE_CONFIG_DIR. */
async function claudeProjectsSources(args: {
  workspaceRoots: readonly string[]
  home?: string
  env?: NodeJS.ProcessEnv
  resolveWslHome?: (distro: string) => Promise<string | null>
}): Promise<{ sources: ClaudeProjectsSource[]; complete: boolean }> {
  const sources: ClaudeProjectsSource[] = []
  let complete = true
  const hostParents = encodeParents(args.workspaceRoots)
  if (hostParents.length > 0) {
    for (const projectsDir of [
      getClaudeProjectsDir(args.home ?? homedir(), args.env ?? process.env),
      ...claudeProfileHistoryDirs('projects')
    ]) {
      sources.push({ projectsDir, encodedParents: hostParents })
    }
  }
  const linuxRootsByDistro = new Map<string, string[]>()
  for (const root of args.workspaceRoots) {
    const wsl = parseWslUncPath(root)
    if (wsl) {
      linuxRootsByDistro.set(wsl.distro, [
        ...(linuxRootsByDistro.get(wsl.distro) ?? []),
        wsl.linuxPath
      ])
    }
  }
  const resolveWslHome = args.resolveWslHome ?? getWslHomeAsync
  for (const [distro, linuxRoots] of linuxRootsByDistro) {
    const distroHome = await resolveWslHome(distro)
    if (distroHome) {
      sources.push({
        projectsDir: join(distroHome, '.claude', 'projects'),
        encodedParents: encodeParents(linuxRoots)
      })
      continue
    }
    // Unresolved distro homes leave agent history unread, so discovery must remain retryable.
    complete = false
  }
  return { sources, complete }
}

/** Best-effort local discovery; SSH-only history cannot be recovered from this host. */
export async function discoverRetiredWorktreeNames(args: {
  workspaceRoots: readonly string[]
  home?: string
  env?: NodeJS.ProcessEnv
  /** Resolves the distro home as a UNC path. */
  resolveWslHome?: (distro: string) => Promise<string | null>
}): Promise<RetirementScanResult> {
  const leafNames: string[] = []
  let refused = false
  for (const root of args.workspaceRoots) {
    const listing = await readDirectoryNames(root)
    refused ||= listing.refused
    leafNames.push(...listing.names)
  }

  const bucketSources = await claudeProjectsSources(args)
  refused ||= !bucketSources.complete
  for (const source of bucketSources.sources) {
    const listing = await readDirectoryNames(source.projectsDir)
    refused ||= listing.refused
    for (const bucket of listing.names) {
      leafNames.push(...extractBucketLeafCandidates(bucket, source.encodedParents))
    }
  }

  return { names: collectRetiredNamesFromLeafNames(leafNames), complete: !refused }
}
