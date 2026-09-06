import type { MobileWebTaskItemMetadataUpdates } from '../../../src/shared/mobile-web/task-item-mutation-contract'

export type HostTaskGitHubItemTarget = {
  provider: 'github'
  repoId: string
  number: number
  type: 'issue' | 'pr'
  targetId?: string
}

export type HostTaskGitLabItemTarget = {
  provider: 'gitlab'
  repoId: string
  number: number
  type: 'issue' | 'mr'
  projectRef?: { host: string; path: string }
  targetId?: string
}

export type HostTaskItemMutationTarget = HostTaskGitHubItemTarget | HostTaskGitLabItemTarget

export type HostTaskItemMutationOperations = {
  setClosed(target: HostTaskItemMutationTarget, closed: boolean): Promise<void>
  updateMetadata(
    target: HostTaskItemMutationTarget,
    updates: MobileWebTaskItemMetadataUpdates
  ): Promise<void>
}
