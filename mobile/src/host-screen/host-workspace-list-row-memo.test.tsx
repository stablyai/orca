import { createElement, Fragment, type ReactNode } from 'react'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Section, Worktree } from '../worktree/workspace-list-types'

const { rowRenders, agentRenders } = vi.hoisted(() => ({
  rowRenders: vi.fn(),
  agentRenders: vi.fn()
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  Animated: {
    SectionList: ({
      sections,
      keyExtractor,
      renderItem
    }: {
      sections: Section[]
      keyExtractor: (item: Worktree) => string
      renderItem: (info: { item: Worktree }) => ReactNode
    }) =>
      sections.flatMap((section) =>
        section.data.map((item) =>
          createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item }))
        )
      )
  },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../components/AgentSpinner', () => ({ AgentSpinner: () => null }))
vi.mock('../components/MobileRepoIcon', () => ({ MobileRepoIcon: () => null }))
vi.mock('../components/WorktreeAgentList', () => ({
  WorktreeAgentList: (props: unknown) => {
    agentRenders(props)
    return null
  }
}))
// Each row always renders glyphs, so glyph calls count row renders.
vi.mock('../components/WorktreeMetaGlyphs', () => ({
  prStateColor: () => '#000000',
  WorktreeMetaGlyphs: () => {
    rowRenders()
    return null
  }
}))

import { buildSections } from '../worktree/workspace-list-sections'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { HostWorkspaceList } from './host-workspace-list'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: `repo-1::${id}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: `feature/${id}`,
    displayName: id,
    path: id,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'active',
    ...overrides
  }
}

const noop = () => {}
const stable = { ref: { current: null }, repoById: new Map() }

function listProps(worktrees: Worktree[]) {
  // Reparse like every poll, producing fresh row objects even for unchanged data.
  const polled: Worktree[] = JSON.parse(JSON.stringify(worktrees))
  const sections = buildSections(polled, 'name', NO_WORKSPACE_ROW_FILTERS, '', 'none', new Set())
  const controller = {
    actions: { openWorktreeSession: noop, openNewWorktreeModal: noop },
    activeWorktreeScroll: { sectionListRef: stable.ref, onScrollToIndexFailed: noop },
    catalog: { refreshing: false, onRefresh: noop },
    connectionVerdict: { kind: 'normal', label: 'Connected' },
    connState: 'connected',
    displayWorktrees: polled,
    embedded: true,
    insets: { bottom: 0 },
    isReadOnly: false,
    now: 1_000,
    reconnectAttempts: 0,
    relayRecovery: { pairingRejected: false },
    sectionsResult: { rawSections: sections, sections, repoById: stable.repoById },
    settings: {
      activeFilterCount: 0,
      toggleWorktreeLineage: noop,
      pendingViewChanges: { pending: [], stale: false }
    },
    state: {
      actionError: '',
      setActionTarget: noop,
      view: { ...INITIAL_MOBILE_VIEW, groupBy: 'none' },
      search: '',
      worktreesLoaded: true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list reads only the controller fields above on this connected, embedded, error-free path.
  return { controller, bottomBarHeight: 0 } as unknown as Parameters<typeof HostWorkspaceList>[0]
}

describe('host list rows across polls', () => {
  it('re-renders only the row whose worktree changed', () => {
    const rows = [worktree('a'), worktree('b'), worktree('c')]
    let tree: ReactTestRenderer | null = null
    act(() => {
      tree = create(createElement(HostWorkspaceList, listProps(rows)))
    })
    rowRenders.mockClear()

    const changed = [rows[0]!, { ...rows[1]!, branch: 'feature/b-renamed' }, rows[2]!]
    act(() => tree!.update(createElement(HostWorkspaceList, listProps(changed))))

    expect(rowRenders).toHaveBeenCalledTimes(1)
    expect(
      tree!.root
        .findAll((node) => String(node.type) === 'Text')
        .flatMap((node) => node.props.children)
    ).toContain('feature/b-renamed')
    act(() => tree!.unmount())
  })
  it('re-renders only the workspace whose child roster changed', () => {
    const row = worktree('a', {
      agents: [
        {
          paneKey: 'parent',
          parentPaneKey: null,
          state: 'working',
          agentType: 'codex',
          prompt: '',
          taskTitle: null,
          displayName: null,
          lastAssistantMessage: null,
          toolName: null,
          toolInput: null,
          interrupted: false,
          stateStartedAt: 1,
          updatedAt: 1,
          subagents: [{ id: 'child', state: 'working', startedAt: 1 }]
        }
      ]
    })
    let tree: ReactTestRenderer | null = null
    act(() => {
      tree = create(createElement(HostWorkspaceList, listProps([row, worktree('b')])))
    })
    rowRenders.mockClear()
    agentRenders.mockClear()
    const changed = {
      ...row,
      agents: [
        {
          ...row.agents![0]!,
          subagents: [{ id: 'child', state: 'waiting' as const, startedAt: 1 }]
        }
      ]
    }
    act(() => tree!.update(createElement(HostWorkspaceList, listProps([changed, worktree('b')]))))
    expect(rowRenders).toHaveBeenCalledTimes(1)
    expect(agentRenders).toHaveBeenCalledTimes(1)
    expect(agentRenders.mock.calls[0]?.[0]).toMatchObject({
      agents: [{ paneKey: 'parent', subagents: [{ id: 'child', state: 'waiting', startedAt: 1 }] }]
    })
    act(() => tree!.unmount())
  })
})

afterEach(unmountRenderers)
