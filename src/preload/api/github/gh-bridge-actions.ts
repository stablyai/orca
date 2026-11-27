import { ipcRenderer } from 'electron'
import type { GithubActionsApi } from './github-actions-api'
export const ghActionsApi: GithubActionsApi = {
  /** Read artifact metadata using the caller’s registered repository, run and account context. */
  actionsArtifacts: (args) => ipcRenderer.invoke('gh:actionsArtifacts', args),
  /** Acquire an owner-bound archive; the returned transfer must be released after save or cancellation. */
  startActionsArtifactDownload: (args) =>
    ipcRenderer.invoke('gh:startActionsArtifactDownload', args),
  /** Read a bounded archive chunk using the original transfer’s repository and account context. */
  readActionsArtifactChunk: (args) => ipcRenderer.invoke('gh:readActionsArtifactChunk', args),
  /** Release retained archive storage using the original transfer owner, including after failed saves. */
  releaseActionsArtifactDownload: (args) =>
    ipcRenderer.invoke('gh:releaseActionsArtifactDownload', args),
  /** Read a filtered run page on the registered repository’s execution host and account. */
  actionsRuns: (args) => ipcRenderer.invoke('gh:actionsRuns', args),
  /** Read a workflow page using the same repository owner as run browsing. */
  actionsWorkflows: (args) => ipcRenderer.invoke('gh:actionsWorkflows', args),
  /** Read jobs for the selected run attempt and page using its pinned repository owner. */
  actionsRunDetails: (args) => ipcRenderer.invoke('gh:actionsRunDetails', args)
}
