/* GitLab preload bindings — split out of `src/preload/index.ts` so
   adding or changing a `gl.*` channel doesn't surface as a merge
   conflict on every upstream sync of the much larger central preload
   file. Composed back into `api.gl` from `index.ts`. */
import { invoke } from './ipc-invoke-boundary'
import type { TaskSourceContext } from '../shared/task-source-context'

type GitLabRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

export const glApi = {
  viewer: (): Promise<unknown> => invoke('gitlab:viewer'),
  diagnoseAuth: (): Promise<unknown> => invoke('gitlab:diagnoseAuth'),
  rateLimit: (args?: { force?: boolean; host?: string | null }): Promise<unknown> =>
    invoke('gitlab:rateLimit', args),

  projectSlug: (args: GitLabRepoSelectorArgs): Promise<unknown> =>
    invoke('gitlab:projectSlug', args),

  mrForBranch: (
    args: GitLabRepoSelectorArgs & {
      branch: string
      linkedMRIid?: number | null
    }
  ): Promise<unknown> => invoke('gitlab:mrForBranch', args),

  mr: (args: GitLabRepoSelectorArgs & { iid: number }): Promise<unknown> =>
    invoke('gitlab:mr', args),

  listMRs: (
    args: GitLabRepoSelectorArgs & {
      state?: 'opened' | 'merged' | 'closed' | 'all'
      page?: number
      perPage?: number
      query?: string
    }
  ): Promise<unknown> => invoke('gitlab:listMRs', args),

  listWorkItems: (
    args: GitLabRepoSelectorArgs & {
      state?: 'opened' | 'merged' | 'closed' | 'all'
      page?: number
      perPage?: number
      query?: string
    }
  ): Promise<unknown> => invoke('gitlab:listWorkItems', args),

  issue: (args: GitLabRepoSelectorArgs & { number: number }): Promise<unknown> =>
    invoke('gitlab:issue', args),

  listIssues: (
    args: GitLabRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'all'
      assignee?: string
      limit?: number
      page?: number
    }
  ): Promise<{ items: unknown[]; totalPages?: number; error?: unknown }> =>
    invoke('gitlab:listIssues', args),

  createIssue: (
    args: GitLabRepoSelectorArgs & {
      title: string
      body: string
    }
  ): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> =>
    invoke('gitlab:createIssue', args),

  updateIssue: (
    args: GitLabRepoSelectorArgs & {
      number: number
      updates: unknown
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> => invoke('gitlab:updateIssue', args),

  addIssueComment: (
    args: GitLabRepoSelectorArgs & { number: number; body: string }
  ): Promise<unknown> => invoke('gitlab:addIssueComment', args),

  listLabels: (args: GitLabRepoSelectorArgs): Promise<string[]> =>
    invoke('gitlab:listLabels', args),

  listAssignableUsers: (args: GitLabRepoSelectorArgs): Promise<unknown[]> =>
    invoke('gitlab:listAssignableUsers', args),

  todos: (args: GitLabRepoSelectorArgs): Promise<unknown[]> => invoke('gitlab:todos', args),

  workItemDetails: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      type: 'issue' | 'mr'
    }
  ): Promise<unknown> => invoke('gitlab:workItemDetails', args),

  closeMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> => invoke('gitlab:closeMR', args),

  reopenMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> => invoke('gitlab:reopenMR', args),

  mergeMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      method?: 'merge' | 'squash' | 'rebase'
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> => invoke('gitlab:mergeMR', args),

  updateMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      updates: unknown
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> => invoke('gitlab:updateMR', args),

  updateMRReviewers: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      reviewerIds: number[]
      projectRef?: unknown
    }
  ): Promise<unknown> => invoke('gitlab:updateMRReviewers', args),

  addMRComment: (args: GitLabRepoSelectorArgs & { iid: number; body: string }): Promise<unknown> =>
    invoke('gitlab:addMRComment', args),

  addMRInlineComment: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      input: unknown
      projectRef?: unknown
    }
  ): Promise<unknown> => invoke('gitlab:addMRInlineComment', args),

  resolveMRDiscussion: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      discussionId: string
      resolved: boolean
    }
  ): Promise<unknown> => invoke('gitlab:resolveMRDiscussion', args),

  jobTrace: (
    args: GitLabRepoSelectorArgs & { jobId: number; projectRef?: unknown; logExcerpt?: boolean }
  ): Promise<unknown> => invoke('gitlab:jobTrace', args),

  retryJob: (
    args: GitLabRepoSelectorArgs & { jobId: number; projectRef?: unknown }
  ): Promise<unknown> => invoke('gitlab:retryJob', args),

  workItemByPath: (
    args: GitLabRepoSelectorArgs & {
      host: string
      path: string
      iid: number
      type: 'issue' | 'mr'
    }
  ): Promise<unknown> => invoke('gitlab:workItemByPath', args)
}
