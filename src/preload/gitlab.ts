/* GitLab preload bindings — split out of `src/preload/index.ts` so
   adding or changing a `gl.*` channel doesn't surface as a merge
   conflict on every upstream sync of the much larger central preload
   file. Composed back into `api.gl` from `index.ts`. */
import { ipcRenderer } from 'electron'

export const glApi = {
  viewer: (): Promise<unknown> => ipcRenderer.invoke('gitlab:viewer'),

  projectSlug: (args: { repoPath: string }): Promise<unknown> =>
    ipcRenderer.invoke('gitlab:projectSlug', args),

  mrForBranch: (args: {
    repoPath: string
    branch: string
    linkedMRIid?: number | null
  }): Promise<unknown> => ipcRenderer.invoke('gitlab:mrForBranch', args),

  mr: (args: { repoPath: string; iid: number }): Promise<unknown> =>
    ipcRenderer.invoke('gitlab:mr', args),

  listMRs: (args: {
    repoPath: string
    state?: 'opened' | 'merged' | 'closed' | 'all'
    page?: number
    perPage?: number
  }): Promise<unknown> => ipcRenderer.invoke('gitlab:listMRs', args),

  listWorkItems: (args: {
    repoPath: string
    state?: 'opened' | 'merged' | 'closed' | 'all'
    page?: number
    perPage?: number
  }): Promise<unknown> => ipcRenderer.invoke('gitlab:listWorkItems', args),

  issue: (args: { repoPath: string; number: number }): Promise<unknown> =>
    ipcRenderer.invoke('gitlab:issue', args),

  listIssues: (args: { repoPath: string; limit?: number }): Promise<unknown[]> =>
    ipcRenderer.invoke('gitlab:listIssues', args),

  createIssue: (args: {
    repoPath: string
    title: string
    body: string
  }): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitlab:createIssue', args),

  updateIssue: (args: {
    repoPath: string
    number: number
    updates: unknown
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitlab:updateIssue', args),

  addIssueComment: (args: { repoPath: string; number: number; body: string }): Promise<unknown> =>
    ipcRenderer.invoke('gitlab:addIssueComment', args),

  listLabels: (args: { repoPath: string }): Promise<string[]> =>
    ipcRenderer.invoke('gitlab:listLabels', args),

  listAssignableUsers: (args: { repoPath: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('gitlab:listAssignableUsers', args),

  todos: (args: { repoPath: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('gitlab:todos', args),

  workItemDetails: (args: {
    repoPath: string
    iid: number
    type: 'issue' | 'mr'
  }): Promise<unknown> => ipcRenderer.invoke('gitlab:workItemDetails', args),

  closeMR: (args: {
    repoPath: string
    iid: number
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitlab:closeMR', args),

  reopenMR: (args: {
    repoPath: string
    iid: number
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitlab:reopenMR', args),

  mergeMR: (args: {
    repoPath: string
    iid: number
    method?: 'merge' | 'squash' | 'rebase'
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitlab:mergeMR', args),

  addMRComment: (args: { repoPath: string; iid: number; body: string }): Promise<unknown> =>
    ipcRenderer.invoke('gitlab:addMRComment', args),

  workItemByPath: (args: {
    repoPath: string
    host: string
    path: string
    iid: number
    type: 'issue' | 'mr'
  }): Promise<unknown> => ipcRenderer.invoke('gitlab:workItemByPath', args)
}
