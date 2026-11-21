import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { parseGitRemoteVerboseOutput } from '../../../../shared/git/remotes/git-remote-identity'
import {
  existingCheckoutFolderNames,
  rankExistingCheckouts,
  type ExistingCheckoutCandidate,
  type ExistingCheckoutSuggestion,
  type FindExistingCheckoutsArgs
} from '../../../../shared/project/host-setup/existing-checkout-suggestions'
import type { NestedRepoCandidate } from '../../../../shared/project/groups/project-group-types'
import {
  hasGitMarker,
  readLocalDirectory,
  scanNestedReposWithFilesystem
} from '../../../project-groups/nested-repo-discovery'
import { runGitProbeOnHost } from '../../../workspaces/catalog/repo-git-remote-identity'

const HOME_CHECKOUT_ROOTS = ['git', 'orca', 'src', 'code', 'projects', 'repos', 'dev', 'work']
// Reaches root/<group>/<owner>/<repo>/<checkout>; checkouts are never descended into, so depth stays cheap.
const ROOT_SCAN_DEPTH = 3
const ROOT_SCAN_TIMEOUT_MS = 5_000
const ROOT_SCAN_MAX_CANDIDATES = 300
const ROOT_SCAN_DEADLINE_MS = ROOT_SCAN_TIMEOUT_MS + 1_000
const MAX_REMOTE_PROBES = 60
const REMOTE_PROBE_CONCURRENCY = 6
const REMOTE_PROBE_TIMEOUT_MS = 3_000

/** Orca's default clone parent sits beside its `workspaces` folder. */
function checkoutRootsFor(
  workspaceDir: string | undefined,
  extraRoots: readonly string[]
): string[] {
  const home = homedir()
  const roots = [...extraRoots]
  if (workspaceDir) {
    roots.push(workspaceDir)
    if (basename(workspaceDir) === 'workspaces') {
      roots.push(dirname(workspaceDir))
    }
  }
  roots.push(...HOME_CHECKOUT_ROOTS.map((name) => join(home, name)))
  return [...new Set(roots.filter((root) => isAbsolute(root)).map((root) => resolve(root)))]
}

async function scanRoot(
  root: string,
  isCandidate: (path: string) => Promise<boolean>
): Promise<NestedRepoCandidate[]> {
  const controller = new AbortController()
  let latest: NestedRepoCandidate[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  // The scanner checks its own timeout only between awaits; a hung mount must not hold the dialog.
  const deadline = new Promise<NestedRepoCandidate[]>((resolveDeadline) => {
    timer = setTimeout(() => {
      controller.abort()
      resolveDeadline(latest)
    }, ROOT_SCAN_DEADLINE_MS)
  })
  const scan = scanNestedReposWithFilesystem({
    path: root,
    signal: controller.signal,
    options: {
      maxDepth: ROOT_SCAN_DEPTH,
      maxRepos: ROOT_SCAN_MAX_CANDIDATES,
      timeoutMs: ROOT_SCAN_TIMEOUT_MS
    },
    onProgress: (progress) => {
      latest = progress.repos
    },
    filesystem: {
      readDirectory: readLocalDirectory,
      joinPath: join,
      basename,
      hasGitMarker: isCandidate,
      // A dotfiles repo at home would otherwise make every root look like one checkout.
      isSelectedPathGitRepo: () => false
    }
  }).then(
    (result) => result.repos,
    () => latest
  )
  try {
    return await Promise.race([scan, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Linked worktrees and submodules point `.git` at another repo; only primary checkouts qualify. */
async function isPrimaryCheckout(path: string): Promise<boolean> {
  try {
    return (await lstat(join(path, '.git'))).isDirectory()
  } catch {
    return false
  }
}

async function readRemoteUrls(path: string): Promise<string[]> {
  try {
    const result = await runGitProbeOnHost(['remote', '-v'], path, LOCAL_EXECUTION_HOST_ID, {
      timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
      hostGit: true
    })
    return result ? parseGitRemoteVerboseOutput(result.stdout).map((entry) => entry.url) : []
  } catch {
    return []
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** Finds checkouts of a project on this machine by scanning a few shallow, bounded roots. */
export async function findExistingCheckouts(
  args: FindExistingCheckoutsArgs & { workspaceDir?: string }
): Promise<ExistingCheckoutSuggestion[]> {
  const names = existingCheckoutFolderNames(args.projectName, args.remoteUrl)
  const isNamed = (path: string): boolean => names.has(basename(path).toLowerCase())
  // Any git marker stops descent so checkouts and worktrees are never walked.
  const isCandidate =
    args.kind === 'git'
      ? hasGitMarker
      : async (path: string) => isNamed(path) || (await hasGitMarker(path))
  const roots = checkoutRootsFor(args.workspaceDir, args.extraRoots ?? [])
  const found = (await Promise.all(roots.map((root) => scanRoot(root, isCandidate)))).flat()
  const deduped = [...new Map(found.map((repo) => [repo.path, repo])).values()]
  const unique =
    args.kind === 'git'
      ? (
          await mapWithConcurrency(deduped, REMOTE_PROBE_CONCURRENCY, async (repo) =>
            (await isPrimaryCheckout(repo.path)) ? repo : null
          )
        ).filter((repo): repo is NestedRepoCandidate => repo !== null)
      : deduped.filter((repo) => isNamed(repo.path))
  const probeRemotes = args.kind === 'git' && Boolean(args.remoteUrl)
  // Same-named checkouts are the likeliest remote matches, so they are probed first.
  const ordered = unique.sort(
    (left, right) =>
      Number(isNamed(right.path)) - Number(isNamed(left.path)) || left.depth - right.depth
  )
  const candidates: ExistingCheckoutCandidate[] = await mapWithConcurrency(
    probeRemotes ? ordered.slice(0, MAX_REMOTE_PROBES) : ordered,
    REMOTE_PROBE_CONCURRENCY,
    async (repo) => ({
      path: repo.path,
      folderName: basename(repo.path),
      remoteUrls: probeRemotes ? await readRemoteUrls(repo.path) : []
    })
  )
  return rankExistingCheckouts({
    candidates,
    projectName: args.projectName,
    remoteUrl: args.remoteUrl
  })
}
