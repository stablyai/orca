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
import { guardWslUncPathAccess } from '../wsl/wsl-unc-access-gate'

export function registerGitLabWorkItemHandlers(store: Store): void {
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

  ipcMain.handle(
    'gitlab:workItemDetails',
    async (
      _event,
      args: GitLabRepoSelectorArgs & {
        iid: number
        type: 'issue' | 'mr'
        includeReviewDetails?: boolean
        /** A checks-panel poll: refused rather than booting a stopped WSL distro (E9). */
        background?: boolean
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const localGitOptions = localGitOptionArgs(store, repo)[0] ?? {}
      const read = (): ReturnType<typeof getWorkItemDetails> =>
        getWorkItemDetails(
          repo.path,
          args.iid,
          args.type,
          repo.issueSourcePreference,
          repoConnectionId(repo),
          undefined,
          localGitOptions,
          { includeReviewDetails: args.includeReviewDetails }
        )
      return args.background
        ? guardWslUncPathAccess(repo.path, read, { wslDistro: localGitOptions.wslDistro })
        : read()
    }
  )

  // Pasted URLs can name another project; use the parsed path instead of cwd.
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
      // Failed lookups must not add unreadable projects to recents.
      if (result) {
        recordGitLabProjectRecent(store, args.host, args.path)
      }
      return result
    }
  )
}
