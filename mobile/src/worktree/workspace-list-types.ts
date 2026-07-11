import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

export type Worktree = {
  sectionListKey?: string
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  hostId?: ExecutionHostId
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
}

export type Section = { key: string; title: string; icon?: 'pin'; data: Worktree[] }
