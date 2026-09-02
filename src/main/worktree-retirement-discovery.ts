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

/** Why: over-retiring costs one name from a 552-entry pool; under-retiring reissues a path whose
 *  agent history is still on disk. So this matches generously and never tries to be exact. */
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

/** The workspace leaf is whatever the bucket has beyond its encoded parent. Deriving it from
 *  trailing dash segments instead makes a numerically named workspace retire its parent
 *  directory's name — and `orca` is in the pool. The first segment is also offered because an
 *  agent run from a subdirectory buckets the whole subpath. */
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

/** WSL UNC listings go through the shared 9P gate, which bounds concurrency and deadlines each
 *  call; off UNC it is a plain `readdir`.
 *
 *  Accepted cost of gating: the gate admits one `scan` task process-wide and its stuck-task check
 *  matches scan-against-scan regardless of route, so the coupling runs both ways. Retirement
 *  discovery can be fast-failed by a wedged transcript scan, and — new here — a retirement listing
 *  wedged on one distro can fast-fail transcript discovery on a healthy one, which an ungated
 *  `readdir` never could. It is still the right trade: the gate holds the only deadline and permit
 *  accounting these UNC reads get, and without it a hung 9P route keeps a libuv thread outright.
 *  A dedicated lane would need a third priority, which is a change to the gate, not to this file.
 *
 *  A gate refusal is reported rather than thrown. Throwing abandoned the whole scan at whichever
 *  source failed first — and for a WSL repo the very first listing is the UNC workspace root, so a
 *  stuck 9P route also lost the plain, readable Windows-side `~/.claude/projects` read that the
 *  caller could always perform. The names that were found are still worth returning; what must not
 *  happen is memoizing the hole, since under-retiring is the direction that leaks. */
async function readDirectoryNames(path: string): Promise<{ names: string[]; refused: boolean }> {
  try {
    const entries = await wslGatedReaddir(path, 'scan')
    return {
      names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      refused: false
    }
  } catch (error) {
    // A missing directory is itself a complete answer: the agent may never have run on this
    // machine. Anything else — a gate refusal, an EIO on a redirected or network home — leaves
    // names unread, and memoizing that as "nothing is retired" is the under-retiring direction.
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { names: [], refused: true }
    }
    return { names: [], refused: isWslUncPath(path) && !(await uncRouteIsReachable(path)) }
  }
}

/** Windows reports an unreachable 9P route as ENOENT, so a shut-down distro is indistinguishable
 *  from one that simply never held buckets — `wsl.ts` refuses to trust a UNC ENOENT for the same
 *  reason. One reachable ancestor settles it: the route is up, so the ENOENT below it is real
 *  absence and the answer is complete.
 *
 *  Walking rather than checking one level, because the ancestors are usually missing too: a distro
 *  where Claude never ran has no `~/.claude` either, and a repo with no workspaces yet has neither
 *  the workspace root nor its parent. Stopping at the first level called those complete-looking
 *  cases unreachable, which is the 60s rescan loop this exists to avoid. */
async function uncRouteIsReachable(path: string): Promise<boolean> {
  let current = path
  // `stat`, not a listing: this only asks whether an ancestor is there, and enumerating a WSL home
  // over 9P to answer that would spend the single scan permit on the composer-open path.
  // Bounded so a pathological path cannot hold that permit; the distro root is only a few levels
  // above anything discovery lists.
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

/** Claude buckets its per-conversation state under a directory derived from the workspace cwd. A
 *  bucket surviving its workspace is exactly the evidence we need: the name was used, the
 *  directory is gone, and reissuing the name would hand the next occupant that conversation.
 *  CLAUDE_CONFIG_DIR relocates the whole state root, buckets included.
 *
 *  Codex is deliberately not scanned: it records the cwd inside
 *  `sessions/YYYY/MM/DD/rollout-*.jsonl` rather than in a directory name, so seeding from it would
 *  mean parsing user conversation files. Names spent only under Codex before this feature shipped
 *  stay issuable; every name spent after it is recorded at create time regardless of agent. */
function getClaudeProjectsDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return override ? join(override, 'projects') : join(home, '.claude', 'projects')
}

/** A bucket directory to scan, paired with the encoded cwds whose workspaces it would hold. */
type ClaudeProjectsSource = {
  projectsDir: string
  encodedParents: string[]
}

// Lowercased on both sides: the recorded cwd can differ in case from ours on case-insensitive
// filesystems, and a missed bucket reissues a live path while a spurious one costs one name.
function encodeParents(paths: readonly string[]): string[] {
  return paths
    .filter((path) => path.length > 0)
    .flatMap((path) => encodeClaudeProjectPaths(path).map((encoded) => encoded.toLowerCase()))
}

/** Every bucket directory that could hold a workspace under these roots.
 *
 *  The Windows-side home is not enough for WSL. A WSL workspace's agent is spawned through
 *  `wsl.exe`, so it runs inside the distro: its cwd is the Linux path, not the UNC spelling, and
 *  its buckets land in the distro's own `~/.claude/projects`. Once the workspace directory is
 *  deleted that distro-local bucket is the only durable evidence the name is spent, so a backfill
 *  that reads only the host home reissues the cwd and hands over the previous conversation.
 *
 *  The distro's own `CLAUDE_CONFIG_DIR` is not readable from the Windows side, so only the default
 *  location is scanned there — the same best-effort contract as the rest of this discovery. */
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
    sources.push({
      projectsDir: getClaudeProjectsDir(args.home ?? homedir(), args.env ?? process.env),
      encodedParents: hostParents
    })
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
    // Resolving the home shells out to `wsl.exe`, which returns nothing for a stopped or slow
    // distro. Treating that as "no buckets" would memoize the STA-4472 hole itself: the distro
    // is exactly where a WSL workspace's history lives, so an unread one must stay retryable.
    complete = false
  }
  return { sources, complete }
}

/** Discovers names already spent for a repo, for the one-time seed of the retirement registry.
 *  Local and best-effort by design — agent state for an SSH workspace lives on the execution host,
 *  so names used only there stay issuable until this host observes them. */
export async function discoverRetiredWorktreeNames(args: {
  workspaceRoots: readonly string[]
  home?: string
  env?: NodeJS.ProcessEnv
  /** Injected in tests; production resolves the distro's `$HOME` as a UNC path. */
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
