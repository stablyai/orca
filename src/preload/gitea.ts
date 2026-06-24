/* Gitea/Forgejo preload bindings — split out of `src/preload/index.ts`
   mirroring preload/gitlab.ts so adding or changing a `gt.*` channel
   doesn't create merge conflicts on the large central preload file.
   Composed back into `api.gt` from `index.ts`. */
import { ipcRenderer } from 'electron'
import type { TaskSourceContext } from '../shared/task-source-context'

type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

export const gtApi = {
  authStatus: (): Promise<unknown> => ipcRenderer.invoke('gitea:authStatus'),

  issue: (args: GiteaRepoSelectorArgs & { number: number }): Promise<unknown> =>
    ipcRenderer.invoke('gitea:issue', args),

  listIssues: (
    args: GiteaRepoSelectorArgs & {
      state?: 'open' | 'closed' | 'all'
      assignee?: string
      limit?: number
    }
  ): Promise<{ items: unknown[]; error?: unknown }> => ipcRenderer.invoke('gitea:listIssues', args),

  createIssue: (
    args: GiteaRepoSelectorArgs & {
      title: string
      body: string
    }
  ): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitea:createIssue', args),

  updateIssue: (
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
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitea:updateIssue', args),

  addIssueComment: (
    args: GiteaRepoSelectorArgs & { number: number; body: string }
  ): Promise<unknown> => ipcRenderer.invoke('gitea:addIssueComment', args),

  listLabels: (args: GiteaRepoSelectorArgs): Promise<string[]> =>
    ipcRenderer.invoke('gitea:listLabels', args),

  listAssignableUsers: (args: GiteaRepoSelectorArgs): Promise<unknown[]> =>
    ipcRenderer.invoke('gitea:listAssignableUsers', args)
}
