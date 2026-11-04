import { translate } from '../i18n/mobile-i18n'
import {
  FLOATING_WORKSPACE_WORKTREE_ID,
  isFloatingWorkspaceWorktreeId
} from '../session/floating-workspace'
import { isLastVisitedWorktreeRow, type LastVisitedWorktreeOnHost } from './host-list-highlight'
import type { WorktreeHostContextOf } from './worktree-host-context-labels'
import type { Section, WorkspaceListItem, Worktree } from './workspace-list-types'

export const FLOATING_SECTION_KEY = 'floating'

export function isFloatingWorktreeRow(
  row: Pick<Worktree, 'worktreeId' | 'workspaceKind'>
): boolean {
  return row.workspaceKind === 'floating' || isFloatingWorkspaceWorktreeId(row.worktreeId)
}

export function isFloatingRepoCandidateId(repoId: string): boolean {
  return repoId === FLOATING_WORKSPACE_WORKTREE_ID
}

export function hasActiveFloatingContent(row: Worktree): boolean {
  return row.liveTerminalCount > 0 || (row.agents?.length ?? 0) > 0 || row.hasAttachedPty
}

function matchesFloatingSearch(row: Worktree, title: string, query: string): boolean {
  if (
    title.toLowerCase().includes(query) ||
    row.displayName.toLowerCase().includes(query) ||
    row.path.toLowerCase().includes(query) ||
    row.repo.toLowerCase().includes(query)
  ) {
    return true
  }
  return (row.agents ?? []).some((agent) =>
    [agent.conversationName, agent.displayName, agent.taskTitle, agent.prompt].some(
      (text) => typeof text === 'string' && text.toLowerCase().includes(query)
    )
  )
}

export function buildFloatingWorkspaceSection(args: {
  liveRows: readonly Worktree[]
  lastVisited: LastVisitedWorktreeOnHost | null
  hostContextOf?: WorktreeHostContextOf
  collapsedGroups?: ReadonlySet<string>
  search?: string
  filterRepoIds?: readonly string[]
}): { section: Section; rawSection: Section } | null {
  if (args.filterRepoIds && args.filterRepoIds.length > 0) {
    return null
  }
  const title = translate('worktree.workspaceListSections.floating', 'Floating')
  const query = args.search?.trim().toLowerCase() ?? ''
  const data: WorkspaceListItem[] = args.liveRows
    .filter((row) => isFloatingWorktreeRow(row) && hasActiveFloatingContent(row))
    .filter((row) => !query || matchesFloatingSearch(row, title, query))
    .map((row) => ({
      row: {
        ...row,
        workspaceKind: 'floating' as const,
        isActive: isLastVisitedWorktreeRow(row, args.lastVisited)
      },
      view: {
        ...(args.hostContextOf ? args.hostContextOf(row) : {}),
        sectionListKey: `${FLOATING_SECTION_KEY}:${row.hostId ?? 'local'}:${row.worktreeId}`
      }
    }))

  if (data.length === 0) {
    return null
  }

  const rawSection: Section = {
    key: FLOATING_SECTION_KEY,
    collapseKey: FLOATING_SECTION_KEY,
    title,
    icon: 'floating',
    count: data.length,
    data
  }
  const isCollapsed = args.collapsedGroups?.has(FLOATING_SECTION_KEY) === true
  return {
    rawSection,
    section: isCollapsed ? { ...rawSection, data: [] } : rawSection
  }
}
