import {
  createElement,
  Fragment,
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { WorktreeAgentRow } from './WorktreeAgentRow'
import { WorktreeListRow, type WorktreeListRowItem } from './WorktreeListRow'

const { agentSpinnerRender, agentStateDotRender, contextPressureDotRender } = vi.hoisted(() => ({
  agentSpinnerRender: vi.fn(),
  agentStateDotRender: vi.fn(),
  contextPressureDotRender: vi.fn()
}))

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
vi.mock('./AgentSpinner', () => ({
  AgentSpinner: (props: unknown) => {
    agentSpinnerRender(props)
    return null
  }
}))
vi.mock('./AgentStateDot', () => ({
  AgentStateDot: (props: unknown) => {
    agentStateDotRender(props)
    return null
  }
}))
vi.mock('./ContextPressureDot', () => ({
  ContextPressureDot: (props: unknown) => {
    contextPressureDotRender(props)
    return null
  }
}))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('./MobileRepoIcon', () => ({ MobileRepoIcon: () => null }))
vi.mock('./WorktreeAgentList', () => ({ WorktreeAgentList: () => null }))
vi.mock('./WorktreeMetaGlyphs', () => ({
  prStateColor: () => '#000000',
  WorktreeMetaGlyphs: () => null
}))

type TestItem = WorktreeListRowItem & {
  status: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  lastOutputAt: number
}

const stableRepoIcon = { type: 'emoji', emoji: 'o' } as const
let updateSibling: Dispatch<SetStateAction<number>> = () => undefined

function ListRowHarness({ item, now }: { item: TestItem; now: number }) {
  const [sibling, setSibling] = useState(0)
  updateSibling = setSibling
  const onPress = useCallback(() => undefined, [])
  const onLongPress = useCallback(() => undefined, [])
  const onToggleLineage = useCallback(() => undefined, [])

  // Sibling state changes re-render the harness without changing the row's props,
  // exercising the row's React.memo bailout.
  return createElement(
    Fragment,
    null,
    createElement(Text, null, sibling),
    createElement(WorktreeListRow, {
      item,
      isReadOnly: false,
      now,
      repoColor: '#000000',
      repoIcon: stableRepoIcon,
      hideRepo: false,
      status: item.status,
      onPress,
      onLongPress,
      onToggleLineage
    })
  )
}

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
  repo: 'orca',
  branch: 'feature/mobile-list',
  displayName: 'mobile-list',
  liveTerminalCount: 1,
  preview: 'Waiting',
  unread: false,
  linkedPR: null,
  agents: [agent()],
  status: 'active',
  lastOutputAt: 1_000
}

describe('memoized worktree rows', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    agentSpinnerRender.mockClear()
    agentStateDotRender.mockClear()
    contextPressureDotRender.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('skips an unrelated parent render but updates for live item fields and time', async () => {
    await act(async () => {
      renderer = create(createElement(ListRowHarness, { item: baseItem, now: 2_000 }))
    })
    expect(agentSpinnerRender).toHaveBeenCalledTimes(1)

    await act(async () => updateSibling((value) => value + 1))
    expect(agentSpinnerRender).toHaveBeenCalledTimes(1)

    let expectedRenders = 1
    const liveUpdates: TestItem[] = [
      { ...baseItem, preview: 'Running tests' },
      { ...baseItem, unread: true },
      { ...baseItem, lastOutputAt: 2_000 },
      { ...baseItem, agents: [agent({ state: 'waiting', updatedAt: 2_000 })] },
      { ...baseItem, status: 'working' }
    ]
    for (const liveUpdate of liveUpdates) {
      await act(async () =>
        renderer!.update(createElement(ListRowHarness, { item: liveUpdate, now: 2_000 }))
      )
      expect(agentSpinnerRender).toHaveBeenCalledTimes(++expectedRenders)
      await act(async () =>
        renderer!.update(createElement(ListRowHarness, { item: baseItem, now: 2_000 }))
      )
      expect(agentSpinnerRender).toHaveBeenCalledTimes(++expectedRenders)
    }

    await act(async () =>
      renderer!.update(createElement(ListRowHarness, { item: baseItem, now: 32_000 }))
    )
    expect(agentSpinnerRender).toHaveBeenCalledTimes(++expectedRenders)
  })

  it('memoizes agent rows without hiding agent updates', async () => {
    const firstAgent = agent()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentRow, {
          agent: firstAgent,
          depth: 0,
          now: 2_000,
          unvisited: false
        })
      )
    })
    expect(agentStateDotRender).toHaveBeenCalledTimes(1)

    await act(async () => {
      renderer!.update(
        createElement(WorktreeAgentRow, {
          agent: firstAgent,
          depth: 0,
          now: 2_000,
          unvisited: false
        })
      )
    })
    expect(agentStateDotRender).toHaveBeenCalledTimes(1)

    await act(async () => {
      renderer!.update(
        createElement(WorktreeAgentRow, {
          agent: agent({ state: 'done', updatedAt: 2_000 }),
          depth: 0,
          now: 2_000,
          unvisited: false
        })
      )
    })
    expect(agentStateDotRender).toHaveBeenCalledTimes(2)
  })

  it('shows per-agent context pressure at every level and nothing when absent', async () => {
    // No host-computed pressure (gate off / no data / older host) → no dot.
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentRow, { agent: agent(), depth: 0, now: 2_000, unvisited: false })
      )
    })
    expect(contextPressureDotRender).not.toHaveBeenCalled()

    // Per-agent rows show all three levels, including 'ok' (desktop row policy).
    await act(async () => {
      renderer!.update(
        createElement(WorktreeAgentRow, {
          agent: agent({
            contextPressure: {
              level: 'ok',
              usedPercent: 12,
              usedTokens: 24_000,
              limitTokens: 200_000,
              limitSource: 'provider'
            }
          }),
          depth: 0,
          now: 2_000,
          unvisited: false
        })
      )
    })
    expect(contextPressureDotRender).toHaveBeenCalledWith({
      pressure: {
        level: 'ok',
        usedPercent: 12,
        usedTokens: 24_000,
        limitTokens: 200_000,
        limitSource: 'provider'
      }
    })
  })

  it('shows the worst-of context pressure rollup only at warning/critical', async () => {
    const okOnly: TestItem = {
      ...baseItem,
      agents: [agent({ contextPressure: { level: 'ok', usedPercent: 30 } })]
    }
    await act(async () => {
      renderer = create(createElement(ListRowHarness, { item: okOnly, now: 2_000 }))
    })
    // Aggregate surface stays quiet at 'ok' (WorktreeAgentList is mocked, so any
    // call here is the row's own rollup dot).
    expect(contextPressureDotRender).not.toHaveBeenCalled()

    const mixed: TestItem = {
      ...baseItem,
      agents: [
        agent({ contextPressure: { level: 'warning', usedPercent: 75 } }),
        agent({ paneKey: 'agent-2', contextPressure: { level: 'critical', usedPercent: 92 } })
      ]
    }
    await act(async () => {
      renderer!.update(createElement(ListRowHarness, { item: mixed, now: 2_000 }))
    })
    expect(contextPressureDotRender).toHaveBeenCalledWith({
      pressure: { level: 'critical', usedPercent: 92 }
    })
  })
})
