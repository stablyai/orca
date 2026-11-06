import { describe, expect, it } from 'vitest'
import { FLOATING_WORKSPACE_WORKTREE_ID } from '../session/floating-workspace'
import { buildHostFeedSections } from '../host-screen/host-sidebar-feed-sections'
import { buildFilterRepos } from './workspace-filter-repos'
import { buildFloatingWorkspaceSection, FLOATING_SECTION_KEY } from './floating-workspace-section'
import type { Worktree } from './workspace-list-types'

function makeFloatingRow(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'floating',
    worktreeId: FLOATING_WORKSPACE_WORKTREE_ID,
    repoId: FLOATING_WORKSPACE_WORKTREE_ID,
    hostId: 'local',
    repo: 'Floating',
    branch: '',
    displayName: 'Floating Workspace',
    path: '/home/aleksei',
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'working',
    agents: [
      {
        paneKey: 'tab-float:pane-1',
        parentPaneKey: null,
        state: 'working',
        agentType: 'antigravity',
        prompt: 'Audit host setup',
        taskTitle: 'Audit host setup',
        displayName: null,
        lastAssistantMessage: null,
        toolName: 'run_command',
        toolInput: null,
        interrupted: false,
        stateStartedAt: 1_000,
        updatedAt: 2_000
      }
    ],
    ...overrides
  }
}

describe('floating-workspace-section', () => {
  it('omits the Floating section when no floating terminals or agents are active', () => {
    const idleFloating = makeFloatingRow({
      liveTerminalCount: 0,
      hasAttachedPty: false,
      agents: []
    })
    expect(
      buildFloatingWorkspaceSection({
        liveRows: [idleFloating],
        lastVisited: null
      })
    ).toBeNull()
  })

  it('builds a collapsible Floating section and preserves count=1 when collapsed', () => {
    const activeFloating = makeFloatingRow()
    const expanded = buildFloatingWorkspaceSection({
      liveRows: [activeFloating],
      lastVisited: { worktreeId: FLOATING_WORKSPACE_WORKTREE_ID }
    })
    expect(expanded?.section).toMatchObject({
      key: FLOATING_SECTION_KEY,
      collapseKey: FLOATING_SECTION_KEY,
      title: 'Floating',
      icon: 'floating',
      count: 1
    })
    expect(expanded?.section.data).toHaveLength(1)
    expect(expanded?.section.data[0]?.row.isActive).toBe(true)

    const collapsed = buildFloatingWorkspaceSection({
      liveRows: [activeFloating],
      lastVisited: null,
      collapsedGroups: new Set([FLOATING_SECTION_KEY])
    })
    expect(collapsed?.section.count).toBe(1)
    expect(collapsed?.section.data).toEqual([])
  })

  it('appends the Floating section to host feed sections and excludes Floating from filter repos', () => {
    const activeFloating = makeFloatingRow()
    const gitRow: Worktree = {
      ...makeFloatingRow(),
      workspaceKind: 'git',
      worktreeId: 'repo-1::/work/w0m',
      repoId: 'repo-1',
      repo: 'w0m',
      branch: 'beta',
      displayName: 'w0m'
    }

    const filterRepos = buildFilterRepos([], [gitRow, activeFloating])
    expect(filterRepos.map((r) => r.id)).toEqual(['repo-1'])

    const sections = buildHostFeedSections({
      rows: [],
      lastVisited: null,
      liveRows: [gitRow, activeFloating],
      hostContextOf: () => ({}),
      repoHostIdByRepoId: new Map(),
      search: ''
    })
    expect(sections.map((s) => s.key)).toEqual(['floating'])
    expect(sections[0]?.icon).toBe('floating')
  })
})
