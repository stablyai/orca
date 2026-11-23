import { describe, expect, it } from 'vitest'
import { notchRemoteSessionRows } from './notch-remote-session-frame'

describe('notch remote evidence clocks', () => {
  it('isolates host identities and never renews repeated evidence or subtracts a host clock', () => {
    const snapshot = {
      worktree: 'repo:main',
      tabs: [
        {
          type: 'terminal',
          id: 'wire-leaf',
          parentTabId: 'terminal-tab',
          leafId: '23456789-abcd-4abc-a123-123456789abc',
          title: 'Review',
          agentStatus: { state: 'working', updatedAt: 9_000_000, stateStartedAt: 8_000_000 }
        }
      ]
    }
    const first = notchRemoteSessionRows('host-a', snapshot, new Map(), 1000, 'pairing-runtime')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      paneKey: 'runtime:host-a|terminal-tab:23456789-abcd-4abc-a123-123456789abc',
      originalPaneKey: 'terminal-tab:23456789-abcd-4abc-a123-123456789abc',
      executionHostId: 'runtime:host-a',
      tabId: 'terminal-tab',
      leafId: '23456789-abcd-4abc-a123-123456789abc',
      receivedAt: 1000,
      mirroredEvidenceReceivedAt: 1000,
      stateStartedAt: 1000
    })
    const previous = new Map(first.map((row) => [row.paneKey, row]))
    const replay = notchRemoteSessionRows('host-a', snapshot, previous, 5000, 'pairing-runtime')
    expect(replay[0]).toMatchObject({
      receivedAt: 1000,
      mirroredEvidenceReceivedAt: 1000,
      stateStartedAt: 1000
    })
    const otherHost = notchRemoteSessionRows('host-b', snapshot, previous, 5000, 'pairing-runtime')
    expect(otherHost[0]).toMatchObject({
      paneKey: 'runtime:host-b|terminal-tab:23456789-abcd-4abc-a123-123456789abc',
      receivedAt: 5000,
      stateStartedAt: 5000
    })
    snapshot.tabs[0].agentStatus = {
      state: 'working',
      updatedAt: 9_100_000,
      stateStartedAt: 9_050_000
    }
    const nextTurn = notchRemoteSessionRows('host-a', snapshot, previous, 6000, 'pairing-runtime')
    expect(nextTurn[0]).toMatchObject({ receivedAt: 6000, stateStartedAt: 6000 })
  })
})
