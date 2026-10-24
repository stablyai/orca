import { describe, expect, it } from 'vitest'
import { agentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  withSessionTabStatusReceipts,
  withoutSessionTabHostOwnership
} from './mobile-session-tab-status-clock'

const MINUTE = 60 * 1000
const PHONE_NOW = 1_800_000_000_000

const terminal = (hostStamp: number): MobileSessionTab => ({
  type: 'terminal',
  id: 'term::leaf',
  title: 'claude',
  terminal: 'pty-1',
  isActive: true,
  agentStatus: {
    state: 'working',
    prompt: '',
    paneKey: 'term:leaf',
    stateHistory: [],
    stateStartedAt: hostStamp,
    updatedAt: hostStamp,
    evidenceObservedAt: hostStamp
  }
})

const chat = (structuredHostOwned: boolean): MobileSessionTab => ({
  type: 'agent-session',
  id: 'agent-session:s1',
  title: 'Claude',
  sessionId: 's1',
  agent: 'claude',
  isActive: false,
  chatStatus: {
    state: 'working',
    updatedAt: PHONE_NOW - 2 * 60 * MINUTE,
    ...(structuredHostOwned ? { structuredHostOwned: true as const } : {})
  }
})

function dot(tab: MobileSessionTab | undefined, now: number) {
  if (tab?.type === 'terminal' && tab.agentStatus) {
    return agentDotState(tab.agentStatus, now)
  }
  return tab?.type === 'agent-session' && tab.chatStatus ? agentDotState(tab.chatStatus, now) : null
}

describe('session tab status on the phone clock', () => {
  it.each([
    ['an hour behind', -60 * MINUTE],
    ['an hour ahead', 60 * MINUTE]
  ])('ages a host %s from when the phone saw the evidence', (_label, skew) => {
    const first = withSessionTabStatusReceipts([terminal(PHONE_NOW + skew)], [], PHONE_NOW)
    expect(dot(first[0], PHONE_NOW)).toBe('working')
    // A replay of the same evidence is a repaint, so the window keeps its first start.
    const replay = withSessionTabStatusReceipts(
      [terminal(PHONE_NOW + skew)],
      first,
      PHONE_NOW + 20 * MINUTE
    )
    expect(dot(replay[0], PHONE_NOW + 29 * MINUTE)).toBe('working')
    expect(dot(replay[0], PHONE_NOW + 31 * MINUTE)).toBe('idle')
  })

  it('keeps a held chat working only while the phone hears from its host', () => {
    const connected = withSessionTabStatusReceipts([chat(true)], [], PHONE_NOW)
    expect(dot(connected[0], PHONE_NOW + 60 * MINUTE)).toBe('working')

    const disconnected = withoutSessionTabHostOwnership(connected)
    expect(dot(disconnected[0], PHONE_NOW + 29 * MINUTE)).toBe('working')
    expect(dot(disconnected[0], PHONE_NOW + 31 * MINUTE)).toBe('idle')

    const reconnected = withSessionTabStatusReceipts(
      [chat(true)],
      disconnected,
      PHONE_NOW + 31 * MINUTE
    )
    expect(dot(reconnected[0], PHONE_NOW + 90 * MINUTE)).toBe('working')
  })

  it('reconciles a shell-masked done tab status with a fresher worktree.ps agent row and retains it across replays', () => {
    const shellTitleStamp = PHONE_NOW - 10 * MINUTE
    const hookStartedStamp = PHONE_NOW - 5 * MINUTE
    const hookUpdatedStamp = PHONE_NOW - 1 * MINUTE
    const maskedTab: MobileSessionTab = {
      type: 'terminal',
      id: 'term::leaf',
      parentTabId: 'term',
      leafId: 'leaf',
      title: 'antigravity',
      terminal: 'pty-1',
      isActive: true,
      agentStatus: {
        state: 'done',
        prompt: '',
        paneKey: 'term:leaf',
        stateHistory: [],
        stateStartedAt: hookStartedStamp,
        updatedAt: shellTitleStamp
      }
    }
    const cachedWorktrees = [
      {
        worktreeId: 'wt-1',
        agents: [
          {
            paneKey: 'term:leaf',
            state: 'working',
            stateStartedAt: hookStartedStamp,
            updatedAt: hookUpdatedStamp
          }
        ]
      }
    ]

    const first = withSessionTabStatusReceipts([maskedTab], [], PHONE_NOW, {
      cachedWorktrees,
      worktreeId: 'wt-1'
    })
    expect(dot(first[0], PHONE_NOW)).toBe('working')

    // Even after the worktree cache is absent, a replay of the same masked snapshot keeps the reconciled state.
    const replay = withSessionTabStatusReceipts([maskedTab], first, PHONE_NOW + 2 * MINUTE)
    expect(dot(replay[0], PHONE_NOW + 2 * MINUTE)).toBe('working')

    // When worktree.ps later reports the turn completed (done), reconciling the already-working
    // in-memory tab transitions it back from yellow (working) to green (done).
    const completedWorktrees = [
      {
        worktreeId: 'wt-1',
        agents: [
          {
            paneKey: 'term:leaf',
            state: 'done',
            stateStartedAt: hookStartedStamp,
            updatedAt: hookUpdatedStamp + MINUTE
          }
        ]
      }
    ]
    const completed = withSessionTabStatusReceipts(first, first, PHONE_NOW + 3 * MINUTE, {
      cachedWorktrees: completedWorktrees,
      worktreeId: 'wt-1'
    })
    expect(dot(completed[0], PHONE_NOW + 3 * MINUTE)).toBe('done')
  })
})
