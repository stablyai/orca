import { claudeProfileHistoryDirs } from '../../../claude-accounts/claude-profile-installed-router'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isWslUncPath, parseWslUncPath } from '../../../../shared/wsl-paths'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import {
  claudeProjectBucketNameBelowScope,
  mayBeHashedClaudeProjectBucketName
} from '../../../ai-vault/scanners/claude/claude-project-dir-encoding'
import { CLAUDE_CWD_BUCKET_LAYOUT } from '../../../ai-vault/session-cwd-bucket-layouts'
import {
  cachedProjectDirCwd,
  cwdBucketScopePrefixes
} from '../../../ai-vault/session-scanner-scope-discovery'
import { wslGatedReaddir, wslGatedStat } from '../../../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../../native-chat/wsl-transcript-fs-error'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import type { RetirementScanResult } from './worktree-retirement-backfill-scan'
import { normalizeRetirableGeneratedName } from './retirable-generated-name'
import { getWslHomeAsync } from '../../../wsl/discovery/distro-catalog'

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
  encodedParents: Iterable<string>
): string[] {
  const bucket = bucketName.toLowerCase()
  // Every matching parent counts: a root parent (`-`) also prefixes the bucket of a longer one.
  return [...encodedParents].flatMap((parent) => {
    const remainder = claudeProjectBucketNameBelowScope(bucket, parent)
    if (!remainder) {
      return []
    }
    const firstSegment = remainder.split('-')[0]
    return remainder === firstSegment ? [remainder] : [remainder, firstSegment]
  })
}

// Each probe lists a bucket and reads up to 3 transcripts. Host dirs overlap; the WSL gate still runs one scan task at a time.
const HASHED_BUCKET_PROBE_CONCURRENCY = 4

/** A permission refusal on one transcript or bucket stays refused on retry, so it must not keep the scan open. */
function isPersistentFileRefusal(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return !(error instanceof WslTranscriptFsError) && (code === 'EACCES' || code === 'EPERM')
}

/** A `<first 200>-<hash>` bucket name has lost the workspace name; its transcript cwd still has it. */
async function hashedBucketLeafNames(
  projectDir: string,
  roots: readonly string[]
): Promise<{ names: string[]; refused: boolean }> {
  let refused = false
  const cwd = await cachedProjectDirCwd(
    projectDir,
    (_issue, error) => {
      refused ||= !isPersistentFileRefusal(error)
    },
    'claude'
  )
  if (!cwd) {
    // Unresolved like a bucket with no cwd; only a retryable refusal leaves the scan incomplete.
    return { names: [], refused }
  }
  // Compare paths, not names: /repo/my-app and /repo/my/app share a bucket name. Fold case like the bucket match.
  const folded = cwd.toLowerCase()
  return {
    names: roots.flatMap(
      (root) => relativePathInsideRoot(root.toLowerCase(), folded)?.split('/')[0] || []
    ),
    refused
  }
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
  /** Workspace roots as this source's Claude records its cwd. */
  roots: string[]
  encodedParents: ReadonlySet<string>
}

// Session History's bucket rules (long-path cut, roots, case, both WSL spellings); missed buckets risk reissuing used paths.
function claudeProjectsSource(projectsDir: string, roots: string[]): ClaudeProjectsSource {
  return {
    projectsDir,
    roots,
    encodedParents: cwdBucketScopePrefixes(CLAUDE_CWD_BUCKET_LAYOUT, roots)
  }
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
  const hostRoots = args.workspaceRoots.filter((root) => root.length > 0)
  if (hostRoots.length > 0) {
    for (const projectsDir of new Set([
      getClaudeProjectsDir(args.home ?? homedir(), args.env ?? process.env),
      ...claudeProfileHistoryDirs('projects')
    ])) {
      sources.push(claudeProjectsSource(projectsDir, hostRoots))
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
      sources.push(claudeProjectsSource(join(distroHome, '.claude', 'projects'), linuxRoots))
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
    const hashedDirs: string[] = []
    for (const bucket of listing.names) {
      const candidates = extractBucketLeafCandidates(bucket, source.encodedParents)
      leafNames.push(...candidates)
      // An in-scope hashed bucket always leaves a remainder (its hash), so it has candidates.
      if (candidates.length > 0 && mayBeHashedClaudeProjectBucketName(bucket)) {
        hashedDirs.push(join(source.projectsDir, bucket))
      }
    }
    const probes = await mapWithConcurrency(hashedDirs, HASHED_BUCKET_PROBE_CONCURRENCY, (dir) =>
      hashedBucketLeafNames(dir, source.roots)
    )
    for (const probe of probes) {
      leafNames.push(...probe.names)
      refused ||= probe.refused
    }
  }

  return { names: collectRetiredNamesFromLeafNames(leafNames), complete: !refused }
}
