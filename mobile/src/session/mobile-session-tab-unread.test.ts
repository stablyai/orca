import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCachedWorktrees } from '../cache/worktree-cache'
import {
  clearTabCompletionTrackerForTests,
  resolveMobileSessionTabDotState,
  seedUnreadWorktreeSessionTabs,
  setCatalogWorktreesForTabStatus
} from './mobile-terminal-tab-agent'

function doneTerminalTab(id: string, stamp: number, isActive = false) {
  return {
    type: 'terminal' as const,
    id,
    terminal: `pty-${id}`,
    isActive,
    agentStatus: {
      state: 'done' as const,
      prompt: 'fix bug',
      paneKey: `${id}:leaf-1`,
      stateHistory: [],
      updatedAt: stamp,
      stateStartedAt: stamp
    }
  }
}

function catalogAgent(paneKey: string, state: 'working' | 'done', stamp: number) {
  return { paneKey, state, updatedAt: stamp, stateStartedAt: stamp }
}

function expectOffscreen(id: string, stamp: number, state: 'done' | 'unread') {
  expect(
    resolveMobileSessionTabDotState(doneTerminalTab(id, stamp), stamp, { isActiveOnScreen: false })
  ).toBe(state)
}

describe('unread worktree tab completion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    clearTabCompletionTrackerForTests()
  })

  afterEach(() => {
    clearTabCompletionTrackerForTests()
    vi.useRealTimers()
  })

  it('marks a catalog-tracked background completion unread when the worktree is entered', () => {
    setCatalogWorktreesForTabStatus(
      [{ worktreeId: 'wt-1', agents: [catalogAgent('tab-bg:leaf-1', 'working', 100)] }],
      100
    )
    setCatalogWorktreesForTabStatus(
      [{ worktreeId: 'wt-1', agents: [catalogAgent('tab-bg:leaf-1', 'done', 200)] }],
      200
    )
    expectOffscreen('tab-bg', 200, 'unread')

    const writeCache = (
      host: string,
      wt: string,
      pane: string,
      state: 'working' | 'done',
      proven = false
    ) =>
      setCachedWorktrees(
        host,
        [
          {
            worktreeId: wt,
            agents: [catalogAgent(pane, state, state === 'done' ? 1_005 : 1_000)]
          }
        ],
        proven ? { proven: true } : undefined
      )
    writeCache('host-unproven', 'wt-unproven', 'tab-seed:leaf-1', 'working')
    writeCache('host-unproven', 'wt-unproven', 'tab-seed:leaf-1', 'done')
    expectOffscreen('tab-seed', 1_005, 'done')
    writeCache('host-proven', 'wt-proven', 'tab-proven:leaf-1', 'working', true)
    writeCache('host-proven', 'wt-proven', 'tab-proven:leaf-1', 'done', true)
    expectOffscreen('tab-proven', 1_005, 'unread')
  })

  it('marks the latest completed tab unread for a cold-start unread worktree', () => {
    setCatalogWorktreesForTabStatus(
      [
        {
          worktreeId: 'wt-cold',
          unread: true,
          agents: [
            catalogAgent('tab-old:leaf-1', 'done', 100),
            catalogAgent('tab-new:leaf-1', 'done', 300)
          ]
        }
      ],
      300
    )
    expect(
      resolveMobileSessionTabDotState(doneTerminalTab('tab-old', 100), 300, {
        isActiveOnScreen: false
      })
    ).toBe('done')
    expectOffscreen('tab-new', 300, 'unread')

    setCatalogWorktreesForTabStatus([{ worktreeId: 'wt-seed', unread: true }], 400)
    const older = doneTerminalTab('tab-seed-old', 100)
    const active = doneTerminalTab('tab-seed-active', 400, true)
    const newer = doneTerminalTab('tab-seed-new', 500)
    seedUnreadWorktreeSessionTabs('wt-seed', [older, active, newer], 500)
    expect(resolveMobileSessionTabDotState(older, 500, { isActiveOnScreen: false })).toBe('done')
    expect(resolveMobileSessionTabDotState(active, 500, { isActiveOnScreen: false })).toBe('done')
    expectOffscreen('tab-seed-new', 500, 'unread')

    setCatalogWorktreesForTabStatus([{ worktreeId: 'wt-tie', unread: true }], 600)
    const idle = doneTerminalTab('tab-tie-idle', 600)
    const focused = doneTerminalTab('tab-tie-focus', 600, true)
    seedUnreadWorktreeSessionTabs('wt-tie', [idle, focused], 600)
    expect(resolveMobileSessionTabDotState(idle, 600, { isActiveOnScreen: false })).toBe('done')
    expectOffscreen('tab-tie-focus', 600, 'unread')
  })
})
