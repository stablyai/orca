import { expect, it } from 'vitest'
import { NotchStatusService } from './notch-status-service'
import { notchRemoteSessionRows } from './notch-remote-session-frame'

it('keeps the same remote completion read across reconnect and cold start without hiding new host transitions', () => {
  const frame = {
    worktree: 'repo:main',
    tabs: [
      {
        type: 'terminal',
        parentTabId: 'terminal-tab',
        leafId: '23456789-abcd-4abc-a123-123456789abc',
        agentStatus: { state: 'done', updatedAt: 9_000_000, stateStartedAt: 8_000_000 }
      }
    ]
  }
  const paneKey = 'runtime:peer|terminal-tab:23456789-abcd-4abc-a123-123456789abc'
  let rows = notchRemoteSessionRows('peer', frame, new Map(), 1000, 'runtime-a/pairing-a')
  const firstRows = rows
  let changed = (): void => {}
  let serialized = '{}'
  const source = {
    getStatusSnapshot: () => rows,
    subscribeStatusRowMutations: (listener: () => void) => {
      changed = listener
      return () => {}
    }
  }
  const scheduleFlush = (flush: () => void): (() => void) => {
    flush()
    return () => {}
  }
  const first = new NotchStatusService({
    source,
    scheduleFlush,
    onAcknowledgedCompletionsChanged: (completions) => {
      serialized = JSON.stringify(completions)
    }
  })
  first.start()
  expect(first.getSummary().counts.done).toBe(1)
  first.acknowledgePanes([paneKey], 1001)
  expect(first.getSummary().counts.done).toBe(0)
  rows = []
  changed()
  rows = firstRows
  changed()
  expect(first.getSummary().counts.done).toBe(0)
  first.stop()

  rows = notchRemoteSessionRows('peer', frame, new Map(), 2000, 'runtime-a/pairing-a')
  const restored = new NotchStatusService({
    source,
    scheduleFlush,
    acknowledgedCompletions: JSON.parse(serialized)
  })
  restored.start()
  expect(restored.getSummary().counts.done).toBe(0)
  frame.tabs[0].agentStatus = { state: 'done', updatedAt: 9_000_100, stateStartedAt: 8_000_000 }
  rows = notchRemoteSessionRows('peer', frame, new Map(), 3000, 'runtime-a/pairing-a')
  changed()
  expect(restored.getSummary().counts.done).toBe(0)
  frame.tabs[0].agentStatus = { state: 'done', updatedAt: 9_000_200, stateStartedAt: 8_000_100 }
  rows = notchRemoteSessionRows('peer', frame, new Map(), 4000, 'runtime-a/pairing-a')
  changed()
  expect(restored.getSummary().counts.done).toBe(1)
  frame.tabs[0].agentStatus = { state: 'done', updatedAt: 9_000_000, stateStartedAt: 8_000_000 }
  rows = notchRemoteSessionRows('peer', frame, new Map(), 5000, 'runtime-b/pairing-b')
  changed()
  expect(restored.getSummary().counts.done).toBe(1)
  restored.stop()
})
