import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardDetails
} from '../../../src/shared/worktree/card-properties'
import { setSelectedSidebarSession } from '../host-screen/selected-sidebar-session'
import { colors } from '../theme/mobile-theme'
import type { Worktree, WorktreeRowView } from '../worktree/workspace-list-types'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'
import { WorktreeListRow } from './WorktreeListRow'

const { agentListRender } = vi.hoisted(() => ({ agentListRender: vi.fn() }))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Bell: 'Bell',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  GitBranch: 'GitBranch',
  GitPullRequest: 'GitPullRequest'
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('./AgentSpinner', () => ({ AgentSpinner: () => null }))
vi.mock('./AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('./MobileRepoIcon', () => ({ MobileRepoIcon: () => null }))
vi.mock('./WorktreeAgentList', () => ({
  WorktreeAgentList: (props: unknown) => {
    agentListRender(props)
    return null
  }
}))
vi.mock('./WorktreeMetaGlyphs', () => ({
  prStateColor: () => '#000000',
  WorktreeMetaGlyphs: () => null
}))

type TestItem = Worktree & WorktreeRowView & { status: NonNullable<Worktree['status']> }

const ALL_DETAILS = getWorktreeCardDetails(DEFAULT_WORKTREE_CARD_PROPERTIES, {
  compactWorktreeCards: false,
  newCardStyle: false
})

function agent(): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'agent-1',
    parentPaneKey: null,
    state: 'working',
    agentType: null,
    prompt: 'Fix the list',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_000
  }
}

const baseItem: TestItem = {
  worktreeId: 'worktree-1',
  repoId: 'repo-1',
  repo: 'orca',
  path: 'mobile-list',
  hasAttachedPty: true,
  isPinned: false,
  branch: 'feature/mobile-list',
  displayName: 'mobile-list',
  liveTerminalCount: 1,
  unread: false,
  linkedPR: null,
  agents: [agent()],
  status: 'active',
  lastOutputAt: 1_000
}

describe('selectable sidebar session rows', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    agentListRender.mockClear()
    setSelectedSidebarSession(null)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('fills the open session and leaves the rest of the workspace card clear', async () => {
    const row = (item: TestItem) =>
      createElement(WorktreeListRow, {
        item,
        view: item,
        isReadOnly: false,
        now: 2_000,
        repoColor: '#000000',
        cardDetails: ALL_DETAILS,
        agentActivityDisplayMode: 'full',
        status: item.status,
        selectableSessions: true,
        onPress: () => undefined,
        onAgentPress: () => undefined
      })
    const cardFill = () =>
      Object.assign(
        {},
        ...findAllByHostType(renderer!.root, 'Pressable')[0]
          .props.style({ pressed: false })
          .filter(Boolean)
      )
    setSelectedSidebarSession({ worktreeId: baseItem.worktreeId, paneKey: 'agent-1' })
    await act(async () => {
      renderer = create(row({ ...baseItem, isActive: true }))
    })
    expect(cardFill().backgroundColor).toBe(colors.bgBase)
    expect(cardFill().borderLeftColor).toBe(colors.textSecondary)
    expect(agentListRender).toHaveBeenCalledWith(
      expect.objectContaining({ selectedPaneKey: 'agent-1' })
    )

    await act(async () => setSelectedSidebarSession(null))
    expect(cardFill().backgroundColor).toBe(colors.bgPanel)
    expect(agentListRender).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedPaneKey: null })
    )
  })

  it('opens the workspace from its own accessibility control', async () => {
    const onPress = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeListRow, {
          item: baseItem,
          view: {},
          isReadOnly: false,
          now: 2_000,
          repoColor: '#000000',
          cardDetails: ALL_DETAILS,
          agentActivityDisplayMode: 'compact',
          status: 'active',
          onPress
        })
      )
    })
    const card = findAllByHostType(renderer!.root, 'Pressable')[0]
    expect(card.props.accessible).toBe(false)
    const workspace = renderer!.root.find((node) => node.props.accessibilityRole === 'button')
    await act(async () => {
      workspace.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } })
    })
    expect(onPress).toHaveBeenCalledWith(baseItem)
  })

  it('announces the lineage toggle as expanded or collapsed', async () => {
    const onToggleLineage = vi.fn()
    const row = (lineageCollapsed: boolean) =>
      createElement(WorktreeListRow, {
        item: baseItem,
        view: { lineageChildCount: 2, lineageCollapsed },
        isReadOnly: false,
        now: 2_000,
        repoColor: '#000000',
        cardDetails: ALL_DETAILS,
        agentActivityDisplayMode: 'compact',
        status: 'active',
        onPress: () => undefined,
        onToggleLineage
      })
    const toggle = () =>
      findAllByHostType(renderer!.root, 'Pressable').find(
        (node) => node.props.accessibilityState?.expanded !== undefined
      )
    await act(async () => {
      renderer = create(row(false))
    })
    expect(toggle()?.props.accessibilityRole).toBe('button')
    expect(toggle()?.props.accessibilityState).toEqual({ expanded: true })
    await act(async () => {
      renderer!.update(row(true))
    })
    expect(toggle()?.props.accessibilityState).toEqual({ expanded: false })
  })
})
