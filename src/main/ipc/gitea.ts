/* Gitea/Forgejo IPC handlers — mirrors ipc/gitlab.ts EXACTLY for the
   issue operations footprint (no MR/PR channels here — those are in the
   existing gitea PR preflight path). */
import { ipcMain } from 'electron'
import { resolve } from 'path'
import type { Repo } from '../../shared/types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import {
  getIssue,
  listIssues,
  createIssue,
  updateIssue,
  addIssueComment,
  listLabels,
  listAssignableUsers
} from '../gitea/issues'
import { getGiteaAuthStatus } from '../gitea/client'

type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

function findRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store): Repo | undefined {
  const sourceRepoId =
    args.sourceContext?.provider === 'gitea' ? args.sourceContext.repoId?.trim() : null
  const repoId = args.repoId?.trim() || sourceRepoId || null
  if (repoId) {
    const repo = store.getRepo(repoId)
    if (repo) {
      return repo
    }
  }
  const resolvedRepoPath = resolve(args.repoPath)
  return store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
}

// Why: mirror github.ts/gitlab.ts assertRegisteredRepo — main-process
// handlers must never operate on a path the user hasn't explicitly
// registered as a repo (filesystem-auth boundary). Source context adds a
// host check so a task fetched from one machine cannot mutate a same-path
// repo on another (gotcha #5 in blueprint).
function assertRegisteredRepo(args: GiteaRepoSelectorArgs, store: Store): Repo {
  const repo = findRegisteredGiteaRepo(args, store)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  if (
    args.sourceContext?.provider === 'gitea' &&
    args.sourceContext.hostId !== getRepoExecutionHostId(repo)
  ) {
    throw new Error('Access denied: Gitea source host does not match repository host')
  }
  return repo
}

function repoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}

export function registerGiteaHandlers(store: Store): void {
  ipcMain.handle('gitea:authStatus', async () => getGiteaAuthStatus())

  ipcMain.handle(
    'gitea:issue',
    async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return getIssue(repo.path, args.number, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:listIssues',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        state?: 'open' | 'closed' | 'all'
        assignee?: string
        limit?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const limit = Math.max(
        1,
        Math.min(100, args.limit && isFinite(args.limit) ? Math.round(args.limit) : 20)
      )
      const state = args.state === 'closed' || args.state === 'all' ? args.state : 'open'
      const result = await listIssues(
        repo.path,
        limit,
        state,
        args.assignee,
        repoConnectionId(repo)
      )
      // Why: map GiteaIssueInfo → row shape the renderer expects. Mirror
      // the GitLab handler's id/type fields so TaskPage can render with
      // the same row component.
      const items = result.items.map((issue) => ({
        id: `gitea-issue-${repo.id}-${issue.number}`,
        type: 'issue' as const,
        number: issue.number,
        title: issue.title,
        state: issue.state === 'open' ? ('opened' as const) : ('closed' as const),
        url: issue.url,
        labels: issue.labels,
        updatedAt: issue.updatedAt ?? '',
        author: issue.author ?? null,
        repoId: repo.id
      }))
      return { items, ...(result.error ? { error: result.error } : {}) }
    }
  )

  ipcMain.handle(
    'gitea:createIssue',
    async (_event, args: GiteaRepoSelectorArgs & { title: string; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return createIssue(repo.path, args.title, args.body, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:updateIssue',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        updates: {
          state?: 'open' | 'closed'
          title?: string
          body?: string
          addLabels?: string[]
          removeLabels?: string[]
          assignees?: string[]
        }
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return updateIssue(repo.path, args.number, args.updates, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:addIssueComment',
    async (_event, args: GiteaRepoSelectorArgs & { number: number; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return addIssueComment(repo.path, args.number, args.body, repoConnectionId(repo))
    }
  )

  ipcMain.handle('gitea:listLabels', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listLabels(repo.path, repoConnectionId(repo))
  })

  ipcMain.handle('gitea:listAssignableUsers', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listAssignableUsers(repo.path, repoConnectionId(repo))
  })
}
