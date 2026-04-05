import { ipcMain } from 'electron'
import { resolve } from 'path'
import type { Store } from '../persistence'
import {
  getPRForBranch,
  getIssue,
  listIssues,
  getPRChecks,
  updatePRTitle,
  mergePR
} from '../github/client'

function assertRegisteredRepoPath(repoPath: string, store: Store): string {
  const resolvedRepoPath = resolve(repoPath)
  const registeredRepo = store.getRepos().find((repo) => resolve(repo.path) === resolvedRepoPath)
  if (!registeredRepo) {
    throw new Error('Access denied: unknown repository path')
  }
  return registeredRepo.path
}

export function registerGitHubHandlers(store: Store): void {
  ipcMain.handle('gh:prForBranch', (_event, args: { repoPath: string; branch: string }) => {
    const repoPath = assertRegisteredRepoPath(args.repoPath, store)
    return getPRForBranch(repoPath, args.branch)
  })

  ipcMain.handle('gh:issue', (_event, args: { repoPath: string; number: number }) => {
    const repoPath = assertRegisteredRepoPath(args.repoPath, store)
    return getIssue(repoPath, args.number)
  })

  ipcMain.handle('gh:listIssues', (_event, args: { repoPath: string; limit?: number }) => {
    const repoPath = assertRegisteredRepoPath(args.repoPath, store)
    return listIssues(repoPath, args.limit)
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
      const repoPath = assertRegisteredRepoPath(args.repoPath, store)
      return getPRChecks(repoPath, args.prNumber, args.headSha, {
        noCache: args.noCache
      })
    }
  )

  ipcMain.handle(
    'gh:updatePRTitle',
    (_event, args: { repoPath: string; prNumber: number; title: string }) => {
      const repoPath = assertRegisteredRepoPath(args.repoPath, store)
      return updatePRTitle(repoPath, args.prNumber, args.title)
    }
  )

  ipcMain.handle(
    'gh:mergePR',
    (
      _event,
      args: { repoPath: string; prNumber: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repoPath = assertRegisteredRepoPath(args.repoPath, store)
      return mergePR(repoPath, args.prNumber, args.method)
    }
  )
}
