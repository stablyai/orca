import { ipcMain } from 'electron'
import { toGitLabJobLogExcerptResult } from '../../../shared/source-control/checks/gitlab/gitlab-job-log-excerpt'
import type { Store } from '../../persistence/loading-store/store'
import { getJobTrace, retryJob } from '../../gitlab/pipelines/pipeline-job-mutations'
import type { ProjectRef } from '../../gitlab/projects/project-ref-parser'

import {
  type GitLabRepoSelectorArgs,
  assertRegisteredRepo,
  localGitOptionArgs,
  repoConnectionId
} from './gitlab-repo-access'

export function registerGitLabCiJobHandlers(store: Store): void {
  ipcMain.handle(
    'gitlab:jobTrace',
    async (
      _event,
      args: GitLabRepoSelectorArgs & {
        jobId: number
        projectRef?: ProjectRef | null
        logExcerpt?: boolean
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const result = await getJobTrace(
        repo.path,
        args.jobId,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
      return args.logExcerpt ? toGitLabJobLogExcerptResult(result) : result
    }
  )

  ipcMain.handle(
    'gitlab:retryJob',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { jobId: number; projectRef?: ProjectRef | null }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return retryJob(
        repo.path,
        args.jobId,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )
}
