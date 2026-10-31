import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

export type DesktopStatus = {
  appVersion?: string
  protocolVersion?: number
  minCompatibleMobileVersion?: number
  // Older hosts omit this capability; hide Floating Workspace when absent.
  floatingWorkspaceEnabled?: boolean
}

export type RepoSummary = {
  id: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  badgeColor?: string
  repoIcon?: RepoIcon | null
}
