import { ipcMain } from 'electron'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GitHubIssueUpdate } from '../../shared/issue-mutation-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import { addIssueComment, listAssignableUsers, listLabels, updateIssue } from '../github/client'
import type { Store } from '../persistence'
import {
  assertRegisteredGitHubRepo,
  getGitHubLocalGitOptionArgs,
  getGitHubRepoConnectionId,
  type GitHubRepoScopedArgs
} from './github-repo-routing'
import { broadcastGitHubWorkItemMutation } from './github-work-item-mutation-events'

export function registerGitHubIssueMutationHandlers(store: Store): void {
  ipcMain.handle(
    'gh:updateIssue',
    async (event, args: GitHubRepoScopedArgs & { number: number; updates: GitHubIssueUpdate }) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.updates || typeof args.updates !== 'object') {
        return { ok: false, error: 'Updates object is required' }
      }
      const result = await updateIssue(
        repo.path,
        args.number,
        args.updates,
        getGitHubRepoConnectionId(repo),
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastGitHubWorkItemMutation(
          { repoPath: repo.path, repoId: repo.id, type: 'issue', number: args.number },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:addIssueComment',
    async (
      event,
      args: {
        repoPath: string
        repoId?: string
        sourceContext?: TaskSourceContext | null
        number: number
        body: string
        type?: 'issue' | 'pr'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body required' }
      }
      const result = await addIssueComment(
        repo.path,
        args.number,
        args.body.trim(),
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastGitHubWorkItemMutation(
          {
            repoPath: repo.path,
            repoId: repo.id,
            type: args.type ?? 'issue',
            number: args.number
          },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle('gh:listLabels', (_event, args: GitHubRepoScopedArgs) => {
    const repo = assertRegisteredGitHubRepo(args, store)
    return listLabels(
      repo.path,
      repo.issueSourcePreference,
      getGitHubRepoConnectionId(repo),
      ...getGitHubLocalGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle('gh:listAssignableUsers', (_event, args: GitHubRepoScopedArgs) => {
    const repo = assertRegisteredGitHubRepo(args, store)
    return listAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      getGitHubRepoConnectionId(repo),
      ...getGitHubLocalGitOptionArgs(store, repo)
    )
  })
}
