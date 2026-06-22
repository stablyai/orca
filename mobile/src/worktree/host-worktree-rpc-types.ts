import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

// Locally-typed subset of the desktop status payload read from status.get.
export type DesktopStatus = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

export type RepoSummary = {
  id: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  badgeColor?: string
  repoIcon?: RepoIcon | null
}
