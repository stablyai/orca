import type { SmartTier } from '../../../src/shared/sidebar-list/sort-stamps'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { AgentWorkingMode } from '../../../src/shared/agent-status-types'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../../src/shared/runtime-types'
import type { ProjectSectionRepo } from '../../../src/shared/project-section-grouping'
import type { WorkspaceRowFilters } from '../../../src/shared/workspace-view/workspace-row-filters'

export type Worktree = {
  sectionListKey?: string
  /** Show the existing project-name surface for a child from another repo. */
  showProjectName?: boolean
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  hostId?: ExecutionHostId
  terminalPlatform?: NodeJS.Platform
  /** Display-only; set when the list spans hosts, so rows say which host they run on. */
  hostContextLabel?: string
  /** Resolved host for the display label; present when legacy rows omit hostId. */
  hostContextHostId?: ExecutionHostId
  /** Display-only; the host's health word beside its label, absent while the host is healthy. */
  hostContextHealthLabel?: string
  repo: string
  branch: string
  displayName: string
  workspaceStatus?: string
  sortOrder?: number
  manualOrder?: number
  lastActivityAt?: number
  smartTier?: SmartTier
  smartAt?: number
  /** The host sorts by its own stamps; see src/shared/sidebar-list/stamp-order.ts. */
  sortedByStamps?: true
  createdAt?: number
  // Why: on-disk worktree directory path. Needed by NewWorktreeModal so the
  // marine-creature fallback dedupes against filesystem basenames.
  path: string
  isArchived?: boolean
  isMainWorktree?: boolean
  hasHostSidebarActivity?: boolean
  /** The paired desktop calls this row another client's (its "Hide other-client workspaces" rule). */
  desktopOtherClient?: true
  /** Workspace options facts the host stamps (RuntimeWorktreePsSummary); older hosts send none. */
  defaultBranch?: boolean
  automationCreated?: true
  automationName?: string
  cliCreated?: true
  detachedHead?: true
  worktreeInstanceId?: string
  lineageWorktreeInstanceId?: string
  parentWorktreeInstanceId?: string
  parentWorktreeId?: string | null
  childWorktreeIds?: string[]
  lineageDepth?: number
  lineageChildCount?: number
  lineageCollapsed?: boolean
  /** The collapse key the shared builder gave this row's children; set only on a feed-built list. */
  lineageGroupKey?: string
  isLastLineageChild?: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  unread: boolean
  lastOutputAt?: number
  isPinned: boolean
  isActive?: boolean
  linkedPR: RuntimeWorktreePsSummary['linkedPR']
  linkedIssue?: number | null
  linkedLinearIssue?: string | null
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  /** Every linked issue and review; hosts before the attachment list omit it. Unchecked wire data. */
  linkedItems?: RuntimeWorktreePsSummary['linkedItems']
  comment?: string
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  workingMode?: AgentWorkingMode
  agents?: RuntimeWorktreeAgentRow[]
}

/** The desktop's Workspace options filters, one shared value. */
export type FilterState = WorkspaceRowFilters

/** A repo as Project sections read it: the desktop's catalog record, or one a row stands in for. */
// repoIcon stays unread wire data until drawn (readMobileRepoIcon).
export type SectionRepo = ProjectSectionRepo & {
  badgeColor?: string
  repoIcon?: unknown
  projectGroupId?: string | null
  projectGroupOrder?: number
}

/** A workspace the host is still creating; the feed names only its project, null under its own header. */
export type SectionPendingCreation = { key: string; repoName: string | null }

export type Section = {
  key: string
  title: string
  icon?: 'pin'
  /** Under Project grouping, the repo whose colour and icon the header shows, as on the desktop. */
  repo?: SectionRepo
  /** The header's own count from a feed-built list, which a collapsed section still shows. */
  count?: number
  /** Drawn under the header, above its rows, as the desktop places them. */
  pendingCreations?: SectionPendingCreation[]
  data: Worktree[]
}
