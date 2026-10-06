import { basename } from 'node:path'
import type { Repo } from '../shared/repo-types'
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID
} from '../shared/execution-host'
import type { Store } from './persistence'
import type { UsageScanWorktreeRef } from './usage/usage-provider-contract'
import { createWorktreeRefs } from './usage/usage-worktree-refs'

export type UsageWorktreeRef = {
  worktreeId: string
  path: string
  displayName: string
}

function getDefaultUsageWorktreeLabel(pathValue: string): string {
  return basename(pathValue)
}

export function loadKnownUsageWorktreesByRepo(
  store: Pick<Store, 'getAllWorktreeMeta'>,
  repos: Repo[]
): Map<string, UsageWorktreeRef[]> {
  // Why resolve the host: a repo row may name its SSH owner only as
  // `executionHostId: ssh:<target>` with a null `connectionId`.
  return collectUsageWorktreesByRepo(
    store,
    repos.filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
  )
}

/** SSH repos grouped by the target that owns them; paths are that host's own paths. */
export function loadKnownSshUsageWorktreesByTarget(
  store: Pick<Store, 'getAllWorktreeMeta'>,
  repos: Repo[]
): Map<string, UsageScanWorktreeRef[]> {
  const reposByTarget = new Map<string, Repo[]>()
  for (const repo of repos) {
    // Why the dialable target: the scan runs on that target's relay, so a row
    // nested under a `runtime:` host is not ours to reach.
    const targetId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
    if (targetId) {
      const targetRepos = reposByTarget.get(targetId) ?? []
      targetRepos.push(repo)
      reposByTarget.set(targetId, targetRepos)
    }
  }
  // Read persisted metadata once, not once per target.
  const worktreeMeta = store.getAllWorktreeMeta()
  const metaStore = { getAllWorktreeMeta: () => worktreeMeta }
  const worktreesByTarget = new Map<string, UsageScanWorktreeRef[]>()
  for (const [targetId, targetRepos] of reposByTarget) {
    worktreesByTarget.set(
      targetId,
      createWorktreeRefs(targetRepos, collectUsageWorktreesByRepo(metaStore, targetRepos))
    )
  }
  return worktreesByTarget
}

function collectUsageWorktreesByRepo(
  store: Pick<Store, 'getAllWorktreeMeta'>,
  scopedRepos: Repo[]
): Map<string, UsageWorktreeRef[]> {
  // Why: all three usage scanners revisit persisted worktree metadata; index
  // repos once instead of linearly searching the full list for every row.
  const reposById = new Map<string, Repo>()
  for (const repo of scopedRepos) {
    const repoId = repo.id
    // Preserve the former Array.find behavior if corrupt state repeats an ID.
    if (!reposById.has(repoId)) {
      reposById.set(repoId, repo)
    }
  }
  const worktreesByRepo = new Map<string, UsageWorktreeRef[]>()
  const seenPathsByRepo = new Map<string, Set<string>>()

  for (const repo of scopedRepos) {
    worktreesByRepo.set(repo.id, [
      {
        worktreeId: `${repo.id}::${repo.path}`,
        path: repo.path,
        displayName: repo.displayName || getDefaultUsageWorktreeLabel(repo.path)
      }
    ])
    seenPathsByRepo.set(repo.id, new Set([repo.path]))
  }

  // Why: usage scans are background/opt-in analytics. Do not spawn
  // `git worktree list` here; it can re-touch macOS protected folders.
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed) {
      continue
    }
    const repo = reposById.get(parsed.repoId)
    if (!repo) {
      continue
    }
    const worktreePath = isFolderRepo(repo)
      ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? parsed.worktreePath)
      : parsed.worktreePath
    const seenPaths = seenPathsByRepo.get(parsed.repoId)
    if (seenPaths?.has(worktreePath)) {
      continue
    }
    seenPaths?.add(worktreePath)
    worktreesByRepo.get(parsed.repoId)?.push({
      worktreeId,
      path: worktreePath,
      displayName: meta.displayName || getDefaultUsageWorktreeLabel(worktreePath)
    })
  }

  return worktreesByRepo
}
