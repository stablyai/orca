import { describe, expect, it } from 'vitest'
import type { HudState } from '../state/hud-store'
import { buildNavContext } from './nav-context'

function baseState(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: { hostId: 'host-a', state: 'connected', compat: null },
    hosts: [
      { id: 'host-a', name: 'a', endpoint: '', deviceToken: '', publicKeyB64: '', lastConnected: 0 }
    ],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: {
      stack: [{ screen: 'dashboard', hostId: 'host-a', cursor: 0, page: 0 }],
      exitDialogArmed: false
    },
    ...overrides
  }
}

describe('buildNavContext.pendingAskNotificationId (finding #5)', () => {
  it('returns the notification id when the worktree is currently in permission status', () => {
    const state = baseState({
      dashboard: {
        rows: [{ worktreeId: 'wt-1', displayName: 'wt-1', status: 'permission' }],
        fetchedAt: 1,
        stale: false
      },
      inbox: {
        entries: [
          {
            notificationId: 'n1',
            title: 't',
            body: 'b',
            worktreeId: 'wt-1',
            receivedAt: 1,
            kind: 'ask'
          }
        ]
      }
    })
    expect(buildNavContext(state).pendingAskNotificationId('host-a')).toBe('n1')
  })

  it('returns null once the worktree status has moved past permission (stale ask)', () => {
    const state = baseState({
      dashboard: {
        rows: [{ worktreeId: 'wt-1', displayName: 'wt-1', status: 'working' }],
        fetchedAt: 2,
        stale: false
      },
      inbox: {
        entries: [
          {
            notificationId: 'n1',
            title: 't',
            body: 'b',
            worktreeId: 'wt-1',
            receivedAt: 1,
            kind: 'ask'
          }
        ]
      }
    })
    expect(buildNavContext(state).pendingAskNotificationId('host-a')).toBeNull()
  })

  it('returns null when the worktree row is gone entirely', () => {
    const state = baseState({
      dashboard: { rows: [], fetchedAt: 2, stale: false },
      inbox: {
        entries: [
          {
            notificationId: 'n1',
            title: 't',
            body: 'b',
            worktreeId: 'wt-1',
            receivedAt: 1,
            kind: 'ask'
          }
        ]
      }
    })
    expect(buildNavContext(state).pendingAskNotificationId('host-a')).toBeNull()
  })

  it('does not leak an ask across hosts', () => {
    const state = baseState({
      connection: { hostId: 'host-b', state: 'connected', compat: null },
      dashboard: {
        rows: [{ worktreeId: 'wt-1', displayName: 'wt-1', status: 'permission' }],
        fetchedAt: 1,
        stale: false
      },
      inbox: {
        entries: [
          {
            notificationId: 'n1',
            title: 't',
            body: 'b',
            worktreeId: 'wt-1',
            receivedAt: 1,
            kind: 'ask'
          }
        ]
      }
    })
    expect(buildNavContext(state).pendingAskNotificationId('host-a')).toBeNull()
  })
})
