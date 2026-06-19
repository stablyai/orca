import type { RepoIcon } from '../../../src/shared/repo-icon'

// Locally-typed subset of the desktop status payload read from status.get.
export type DesktopStatus = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

export type RepoSummary = {
  id: string
  displayName: string
  badgeColor?: string
  repoIcon?: RepoIcon | null
}
