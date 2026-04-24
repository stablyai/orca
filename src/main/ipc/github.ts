import { ipcMain } from 'electron'
import { resolve } from 'path'
import type { Repo, GitHubIssueUpdate } from '../../shared/types'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import {
  getPRForBranch,
  getIssue,
  getRepoSlug,
  listIssues,
  listWorkItems,
  getWorkItem,
  createIssue,
  updateIssue,
  addIssueComment,
  listLabels,
  listAssignableUsers,
  getAuthenticatedViewer,
  getPRChecks,
  getPRComments,
  resolveReviewThread,
  updatePRTitle,
  mergePR,
  checkOrcaStarred,
  starOrca
} from '../github/client'
import { getWorkItemDetails, getPRFileContents } from '../github/work-item-details'
import type { GitHubPRFile } from '../../shared/types'

// Why: returns the full Repo object instead of just the path string so that
// callers have access to repo.id for stat tracking and other context.
function assertRegisteredRepo(repoPath: string, store: Store): Repo {
  const resolvedRepoPath = resolve(repoPath)
  const repo = store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  return repo
}

export function registerGitHubHandlers(store: Store, stats: StatsCollector): void {
  ipcMain.handle('gh:prForBranch', async (_event, args: { repoPath: string; branch: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    const pr = await getPRForBranch(repo.path, args.branch)
    // Emit pr_created when a PR is first detected for a branch.
    // Why here: the renderer polls gh:prForBranch to check PR status per worktree.
    // This captures PRs opened from any workflow (Orca UI, gh CLI, github.com).
    if (pr && !stats.hasCountedPR(pr.url)) {
      stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: pr.number, prUrl: pr.url }
      })
    }
    return pr
  })

  ipcMain.handle('gh:issue', (_event, args: { repoPath: string; number: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getIssue(repo.path, args.number)
  })

  ipcMain.handle('gh:listIssues', (_event, args: { repoPath: string; limit?: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listIssues(repo.path, args.limit)
  })

  ipcMain.handle(
    'gh:createIssue',
    (_event, args: { repoPath: string; title: string; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return createIssue(repo.path, args.title, args.body)
    }
  )

  ipcMain.handle(
    'gh:listWorkItems',
    (_event, args: { repoPath: string; limit?: number; query?: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return listWorkItems(repo.path, args.limit, args.query)
    }
  )

  ipcMain.handle('gh:workItem', (_event, args: { repoPath: string; number: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getWorkItem(repo.path, args.number)
  })

  ipcMain.handle('gh:workItemDetails', (_event, args: { repoPath: string; number: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getWorkItemDetails(repo.path, args.number)
  })

  ipcMain.handle(
    'gh:prFileContents',
    (
      _event,
      args: {
        repoPath: string
        prNumber: number
        path: string
        oldPath?: string
        status: GitHubPRFile['status']
        headSha: string
        baseSha: string
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getPRFileContents({
        repoPath: repo.path,
        prNumber: args.prNumber,
        path: args.path,
        oldPath: args.oldPath,
        status: args.status,
        headSha: args.headSha,
        baseSha: args.baseSha
      })
    }
  )

  ipcMain.handle('gh:repoSlug', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getRepoSlug(repo.path)
  })

  ipcMain.handle(
    'gh:prChecks',
    (
      _event,
      args: {
        repoPath: string
        prNumber: number
        headSha?: string
        noCache?: boolean
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getPRChecks(repo.path, args.prNumber, args.headSha, {
        noCache: args.noCache
      })
    }
  )

  ipcMain.handle(
    'gh:prComments',
    (_event, args: { repoPath: string; prNumber: number; noCache?: boolean }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getPRComments(repo.path, args.prNumber, { noCache: args.noCache })
    }
  )

  ipcMain.handle(
    'gh:resolveReviewThread',
    (_event, args: { repoPath: string; threadId: string; resolve: boolean }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return resolveReviewThread(repo.path, args.threadId, args.resolve)
    }
  )

  ipcMain.handle(
    'gh:updatePRTitle',
    (_event, args: { repoPath: string; prNumber: number; title: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return updatePRTitle(repo.path, args.prNumber, args.title)
    }
  )

  ipcMain.handle(
    'gh:mergePR',
    (
      _event,
      args: { repoPath: string; prNumber: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return mergePR(repo.path, args.prNumber, args.method)
    }
  )

  ipcMain.handle(
    'gh:updateIssue',
    (_event, args: { repoPath: string; number: number; updates: GitHubIssueUpdate }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.updates || typeof args.updates !== 'object') {
        return { ok: false, error: 'Updates object is required' }
      }
      return updateIssue(repo.path, args.number, args.updates)
    }
  )

  ipcMain.handle(
    'gh:addIssueComment',
    (_event, args: { repoPath: string; number: number; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body required' }
      }
      return addIssueComment(repo.path, args.number, args.body.trim())
    }
  )

  ipcMain.handle('gh:listLabels', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listLabels(repo.path)
  })

  ipcMain.handle('gh:listAssignableUsers', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listAssignableUsers(repo.path)
  })

  // Star operations target the Orca repo itself — no repoPath validation needed
  ipcMain.handle('gh:viewer', () => getAuthenticatedViewer())
  ipcMain.handle('gh:checkOrcaStarred', () => checkOrcaStarred())
  ipcMain.handle('gh:starOrca', () => starOrca())
}
