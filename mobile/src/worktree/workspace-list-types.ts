import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

export type Worktree = {
  sectionListKey?: string
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  hostId?: ExecutionHostId
  /** Opaque filter identity when one list combines multiple desktop catalogs. */
  executionHostFilterId?: string
  executionHostFilterLabel?: string
  terminalPlatform?: NodeJS.Platform
  repo: string
  branch: string
  displayName: string
  workspaceStatus?: string
  sortOrder?: number
  manualOrder?: number
  lastActivityAt?: number
  createdAt?: number
  // Why: on-disk worktree directory path. Needed by NewWorktreeModal so the
  // marine-creature fallback dedupes against filesystem basenames.
  path: string
  isArchived?: boolean
  isMainWorktree?: boolean
  hasHostSidebarActivity?: boolean
  worktreeInstanceId?: string
  lineageWorktreeInstanceId?: string
  parentWorktreeInstanceId?: string
  parentWorktreeId?: string | null
  childWorktreeIds?: string[]
  lineageDepth?: number
  lineageChildCount?: number
  lineageCollapsed?: boolean
  isLastLineageChild?: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  preview: string
  unread: boolean
  lastOutputAt?: number
  isPinned: boolean
  isActive?: boolean
  linkedPR: { number: number; state: string } | null
  linkedIssue?: number | null
  linkedLinearIssue?: string | null
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  comment?: string
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  agents?: RuntimeWorktreeAgentRow[]
}

export type FilterState = {
  filterRepoIds: Set<string>
  hideSleeping: boolean
  hideDefaultBranch: boolean
  /** Absent means on: #8873's exemption must fail open on older host payloads. */
  alwaysShowDefaultBranch?: boolean
  /**
   * Execution hosts (local / WSL / SSH) to keep, mirroring the desktop sidebar's
   * visibleWorkspaceHostIds. Absent or empty means every host, so a payload from
   * a runtime that omits hostId is never filtered away.
   */
  filterExecutionHostIds?: ReadonlySet<string>
}

// Generic over the row shape so a merged cross-desktop list keeps its own row
// type through the filter/group/sort pipeline instead of widening to Worktree.
export type Section<T extends Worktree = Worktree> = {
  key: string
  title: string
  icon?: 'pin'
  data: T[]
}
