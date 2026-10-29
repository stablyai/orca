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
  // Show execution-host context when the list spans hosts.
  hostContextLabel?: string
  /** Resolved host for the display label; present when legacy rows omit hostId. */
  hostContextHostId?: ExecutionHostId
  // Omit health labels for healthy hosts.
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
  // Use filesystem basenames to dedupe fallback workspace names.
  path: string
  /** Older paths of a renamed or moved workspace; older hosts omit it. */
  priorWorktreeIds?: string[]
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
  // Match the desktop’s project-group row depth.
  projectGroupDepth?: number
  /** Its project group came from a folder scan, whose rows the desktop steps more compactly. */
  inFolderScanGroup?: boolean
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
  /** Unchecked wire data: a newer host may send a state this build does not know. */
  sidebarStatus?: string
  workingMode?: AgentWorkingMode
  agents?: RuntimeWorktreeAgentRow[]
}

/** The desktop's Workspace options filters, one shared value. */
export type FilterState = WorkspaceRowFilters

// Catalog repo or fallback from a workspace row.
// repoIcon stays unread wire data until drawn (readMobileRepoIcon).
export type SectionRepo = ProjectSectionRepo & {
  badgeColor?: string
  repoIcon?: unknown
  projectGroupId?: string | null
  projectGroupOrder?: number
}

// Pending creations name only their project; null belongs under the list’s own header.
export type SectionPendingCreation = { key: string; repoName: string | null }

export type Section = {
  key: string
  title: string
  icon?: 'pin'
  repo?: SectionRepo
  isProjectGroup?: boolean
  projectGroupDepth?: number
  /** The header's own count from a feed-built list, which a collapsed section still shows. */
  count?: number
  pendingCreations?: SectionPendingCreation[]
  data: Worktree[]
}
