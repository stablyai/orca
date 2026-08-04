import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

// Locally-typed subset of the desktop status payload read from status.get.
export type DesktopStatus = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
  // Why: absent on hosts that predate the mobile Floating Workspace entry;
  // treat absence as unsupported and hide the entry.
  floatingWorkspaceEnabled?: boolean
  // Why: the desktop's own app version (semver); informational only.
  appVersion?: string
  // Why: release trains can diverge; absent on older hosts — fail open and
  // show no update nudge.
  recommendedMobileAppVersions?: {
    ios?: string
    android?: string
  }
  // Why: new hosts use this to request one post-refresh status update; old hosts omit it.
  recommendedMobileAppVersionsPending?: boolean
}

export type RepoSummary = {
  id: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  badgeColor?: string
  repoIcon?: RepoIcon | null
}
