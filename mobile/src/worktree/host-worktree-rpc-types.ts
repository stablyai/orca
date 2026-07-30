import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

// Locally-typed subset of the desktop status payload read from status.get.
export type DesktopStatus = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
  // Why: absent on hosts that predate the mobile Floating Workspace entry;
  // treat absence as unsupported and hide the entry.
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
