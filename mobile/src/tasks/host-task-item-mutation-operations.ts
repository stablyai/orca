export type HostTaskItemMetadataUpdates = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type HostTaskGitHubItemTarget = {
  provider: 'github'
  repoId: string
  number: number
  type: 'issue' | 'pr'
}

export type HostTaskGitLabItemTarget = {
  provider: 'gitlab'
  repoId: string
  number: number
  type: 'issue' | 'mr'
  projectRef?: { host: string; path: string }
}

export type HostTaskItemMutationTarget = HostTaskGitHubItemTarget | HostTaskGitLabItemTarget

export type HostTaskItemMutationOperations = {
  setClosed(target: HostTaskItemMutationTarget, closed: boolean): Promise<void>
  updateMetadata(
    target: HostTaskItemMutationTarget,
    updates: HostTaskItemMetadataUpdates
  ): Promise<void>
}
