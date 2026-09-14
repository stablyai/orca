import { ipcMain } from 'electron'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import {
  normalizeGitLabMRListState,
  normalizeGitLabPositiveInteger,
  normalizeGitLabSearchQuery
} from '../gitlab/gitlab-preload-args'
import { recordGitLabProjectRecent } from '../gitlab/gitlab-project-recents'
import { getWorkItemByProjectRef, listWorkItems } from '../gitlab/client'
import { getWorkItemDetails } from '../gitlab/work-item-details'
import type { ProjectRef } from '../gitlab/gl-utils'
import type { GitLabRepoSelectorArgs } from './gitlab-repo-access'
import { assertRegisteredRepo, localGitOptionArgs, repoConnectionId } from './gitlab-repo-access'

export function registerGitLabWorkItemHandlers(store: Store): void {
  // Why: combined MR + issue list — Tasks screen and any future picker
  // that wants a unified view. Centralizes the merge / sort logic so
  // callers don't have to re-implement it.
  ipcMain.handle(
    'gitlab:listWorkItems',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        state?: 'opened' | 'merged' | 'closed' | 'all'
        page?: number
        perPage?: number
        query?: string
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return listWorkItems(
        repo.path,
        normalizeGitLabMRListState(args.state),
        normalizeGitLabPositiveInteger(args.page, 1, 10_000),
        normalizeGitLabPositiveInteger(args.perPage, 20, 100),
        repo.issueSourcePreference,
        normalizeGitLabSearchQuery(args.query),
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  // Why: aggregated dialog payload — body + discussions + pipeline jobs.
  // Powers GitLabItemDialog's tabs.
  ipcMain.handle(
    'gitlab:workItemDetails',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number; type: 'issue' | 'mr' }) => {
      const repo = assertRegisteredRepo(args, store)
      return getWorkItemDetails(
        repo.path,
        args.iid,
        args.type,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  // Why: paste-URL flow in the picker. The user pastes a GitLab URL that
  // may target a project different from the local checkout's remote, so
  // the call carries the parsed project path explicitly rather than
  // resolving from cwd.
  ipcMain.handle(
    'gitlab:workItemByPath',
    async (
      _event,
      args: GitLabRepoSelectorArgs & {
        host: string
        path: string
        iid: number
        type: 'issue' | 'mr'
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const projectRef: ProjectRef = { host: args.host, path: args.path }
      const result = await getWorkItemByProjectRef(
        repo.path,
        projectRef,
        args.iid,
        args.type,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
      // Why: only persist a recent entry when the lookup actually
      // produced an item. A 404 / auth failure shouldn't pollute the
      // user's recents list with project paths they can't read.
      if (result) {
        recordGitLabProjectRecent(store, args.host, args.path)
      }
      return result
    }
  )
}
