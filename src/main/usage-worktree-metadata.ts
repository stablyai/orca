import { basename } from 'node:path'
import { resolveFolderWorkspaceHost } from '../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../shared/folder-workspace-worktree'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import type { Store } from './persistence'

export type UsageWorktreeRef = {
  worktreeId: string
  path: string
  displayName: string
}

function getDefaultUsageWorktreeLabel(pathValue: string): string {
  return basename(pathValue)
}

export function loadKnownUsageWorktreesByRepo(
  // Optional so partial store doubles stay valid; every real Store provides both.
  store: Pick<Store, 'getAllWorktreeMeta'> & {
    getFolderWorkspaces?: () => FolderWorkspace[]
    getProjectGroups?: () => ProjectGroup[]
  },
  repos: Repo[]
): Map<string, UsageWorktreeRef[]> {
  const localRepos = repos.filter((repo) => !repo.connectionId)
  // Why: all three usage scanners revisit persisted worktree metadata; index
  // repos once instead of linearly searching the full list for every row.
  const localReposById = new Map<string, Repo>()
  for (const repo of localRepos) {
    const repoId = repo.id
    // Preserve the former Array.find behavior if corrupt state repeats an ID.
    if (!localReposById.has(repoId)) {
      localReposById.set(repoId, repo)
    }
  }
  const worktreesByRepo = new Map<string, UsageWorktreeRef[]>()
  const seenPathsByRepo = new Map<string, Set<string>>()

  for (const repo of localRepos) {
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
    const repo = localReposById.get(parsed.repoId)
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

  const folderWorkspaces = store.getFolderWorkspaces?.() ?? []
  const folderWorkspaceHostState = {
    folderWorkspaces,
    projectGroups: store.getProjectGroups?.() ?? [],
    repos
  }

  // Why: folder workspaces host real agent sessions but are neither repos nor
  // worktree metadata. Without a ref their cwd falls back to `cwd:<path>` and
  // the default Orca scope drops every row (#20477).
  for (const workspace of folderWorkspaces) {
    // Why: the scanners only read this host's transcripts, so resolve ownership the way the rest of
    // the app does instead of reading `connectionId` raw. A repo in scope can name its SSH host only
    // through `executionHostId`, and `ambiguous` must fail closed rather than index a remote path.
    if (resolveFolderWorkspaceHost(folderWorkspaceHostState, workspace.id).kind !== 'local') {
      continue
    }
    const worktree = folderWorkspaceToWorktree(workspace)
    const ref: UsageWorktreeRef = {
      worktreeId: worktree.id,
      path: worktree.path,
      displayName: worktree.displayName || getDefaultUsageWorktreeLabel(worktree.path)
    }
    // A folder workspace sharing a directory with a repo adds a second ref for that path. Both ids
    // are non-null, so nothing drops from the Orca scope; which one labels the row is the provider's
    // exact-path precedence.
    const refs = worktreesByRepo.get(worktree.repoId)
    if (refs) {
      refs.push(ref)
    } else {
      worktreesByRepo.set(worktree.repoId, [ref])
    }
  }

  return worktreesByRepo
}
