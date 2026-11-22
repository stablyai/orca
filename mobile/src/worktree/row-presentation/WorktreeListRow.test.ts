import { createElement } from 'react'
import { Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import type { Worktree, WorktreeRowView } from '../workspace-list/workspace-list-types'
import { WorktreeListRow } from './WorktreeListRow'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { BotLineAgentMore } from './BotLineAgentMore'
import {
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardDetails
} from '../../../../src/shared/worktree/row-display/card-properties'

const { agentSpinnerRender, agentStateDotRender, metaGlyphsRender } = vi.hoisted(() => ({
  agentSpinnerRender: vi.fn(),
  agentStateDotRender: vi.fn(),
  metaGlyphsRender: vi.fn()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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
  GitPullRequest: 'GitPullRequest',
  Monitor: 'Monitor',
  Server: 'Server'
}))

vi.mock('../../platform/haptics/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../../agents/presentation/AgentSpinner', () => ({
  AgentSpinner: (props: unknown) => {
    agentSpinnerRender(props)
    return null
  }
}))
vi.mock('../../agents/presentation/AgentStateDot', () => ({
  AGENT_ATTENTION_COLOR: '#ef4444',
  AgentStateDot: (props: unknown) => {
    agentStateDotRender(props)
    return null
  }
}))
vi.mock('../../components/icons/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('../../components/icons/MobileRepoIcon', () => ({ MobileRepoIcon: () => null }))
vi.mock('../agent-lineage/presentation/WorktreeAgentList', () => ({
  WorktreeAgentList: () => null
}))
vi.mock('./WorktreeMetaGlyphs', () => ({
  prStateColor: () => '#000000',
  WorktreeMetaGlyphs: (props: unknown) => {
    metaGlyphsRender(props)
    return null
  }
}))

// Row plus its view facts; the harness passes the same object as `item` and `view`.
type TestItem = Worktree & WorktreeRowView & { status: NonNullable<Worktree['status']> }

const detailsFor = (compactWorktreeCards: boolean, newCardStyle: boolean) =>
  getWorktreeCardDetails(DEFAULT_WORKTREE_CARD_PROPERTIES, {
    compactWorktreeCards,
    newCardStyle
  })
const ALL_DETAILS = detailsFor(false, false)

function agent(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
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
    updatedAt: 1_000,
    ...overrides
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

describe('memoized worktree rows', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    agentSpinnerRender.mockClear()
    agentStateDotRender.mockClear()
    metaGlyphsRender.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it("shows a bot worker line's agents by kind, at most two logos, then +N", async () => {
    const draw = async (agents: RuntimeWorktreeAgentRow[], view: WorktreeRowView, now = 2_000) => {
      vi.useFakeTimers({ now })
      await act(async () => {
        renderer = create(
          createElement(WorktreeListRow, {
            item: { ...baseItem, agents },
            view,
            isReadOnly: false,
            repoColor: '#000000',
            hideRepo: false,
            cardDetails: ALL_DETAILS,
            agentActivityDisplayMode: 'compact',
            status: 'active',
            onPress: () => undefined
          })
        )
      })
      const root = renderer!.root
      const result = {
        logos: root.findAllByType(MobileAgentIcon).map((node) => node.props.agentId),
        more: root.findAllByType(BotLineAgentMore).map((node) => node.props.others),
        needsYou: root.findAllByType(BotLineAgentMore).map((node) => node.props.needsYou),
        // +N leads the title, after the logo.
        moreBeforeTitle: root.findAllByType(BotLineAgentMore).every((more) => {
          const row = more.parent!.children
          return (
            row.indexOf(more) <
            row.findIndex((node) => typeof node !== 'string' && node.type === Text)
          )
        })
      }
      act(() => renderer?.unmount())
      renderer = null
      return result
    }
    // A bot's worker points at the bot's chat in another workspace; that is not a subagent.
    const dispatched = agent({
      paneKey: 'worker',
      parentPaneKey: 'bot-home-pane',
      agentType: 'codex'
    })
    expect(await draw([dispatched], { botWorkspace: true })).toEqual({
      logos: ['codex'],
      more: [],
      needsYou: [],
      moreBeforeTitle: true
    })
    expect(
      await draw(
        [
          dispatched,
          agent({ paneKey: 'a', agentType: 'claude' }),
          agent({ paneKey: 'b', agentType: 'claude' })
        ],
        { botWorkspace: true }
      )
    ).toEqual({
      logos: ['claude', 'codex'],
      more: [],
      needsYou: [],
      moreBeforeTitle: true
    })
    expect(
      await draw(
        [
          dispatched,
          agent({ paneKey: 'a', agentType: 'claude' }),
          agent({ paneKey: 'b', agentType: 'claude' }),
          agent({ paneKey: 'c', agentType: 'gemini' })
        ],
        { botWorkspace: true }
      )
    ).toEqual({
      logos: ['claude', 'codex'],
      more: [1],
      needsYou: [false],
      moreBeforeTitle: true
    })
    expect(await draw([dispatched], {})).toEqual({
      logos: [],
      more: [],
      needsYou: [],
      moreBeforeTitle: true
    })
  })

  it("lights a bot worker line's +N only while a hidden agent still shows as needing you", async () => {
    const draw = async (now: number) => {
      vi.useFakeTimers({ now })
      await act(async () => {
        renderer = create(
          createElement(WorktreeListRow, {
            item: {
              ...baseItem,
              agents: [
                agent({
                  paneKey: 'codex',
                  agentType: 'codex',
                  updatedAt: now,
                  stateStartedAt: now
                }),
                agent({
                  paneKey: 'claude',
                  agentType: 'claude',
                  updatedAt: now,
                  stateStartedAt: now
                }),
                agent({
                  paneKey: 'gemini',
                  agentType: 'gemini',
                  state: 'blocked',
                  hasLivePty: true
                })
              ]
            },
            view: { botWorkspace: true },
            isReadOnly: false,
            repoColor: '#000000',
            hideRepo: false,
            cardDetails: ALL_DETAILS,
            agentActivityDisplayMode: 'compact',
            status: 'active',
            onPress: () => undefined
          })
        )
      })
      const needsYou = renderer!.root
        .findAllByType(BotLineAgentMore)
        .map((node) => node.props.needsYou)
      act(() => renderer?.unmount())
      renderer = null
      return needsYou
    }
    expect(await draw(2_000)).toEqual([true])
    // Half an hour without word, the blocked pane reads unverifiable in the agent list.
    expect(await draw(1_000 + 31 * 60_000)).toEqual([false])
  })

  it('draws a host row carrying the bot name as a workspace, not as the bot', async () => {
    // Hosts send `bot` as the owning bot's name on its home and worker rows.
    const hostRow = { ...baseItem, bot: 'Scout', botHome: true as const }
    vi.useFakeTimers({ now: 2_000 })
    await act(async () => {
      renderer = create(
        createElement(WorktreeListRow, {
          item: hostRow,
          view: {},
          isReadOnly: false,
          repoColor: '#000000',
          hideRepo: false,
          cardDetails: ALL_DETAILS,
          agentActivityDisplayMode: 'compact',
          status: 'active',
          onPress: () => undefined
        })
      )
    })
    const texts = renderer!.root.findAllByType(Text).map((node) => node.props.children)
    expect(texts).toContain(baseItem.repo)
  })
})
