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
  first.acknowledgePanes([{ paneKey, stateStartedAt: 8_000_000, observedAt: 1001 }])
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

it('keeps viewing transient and host-qualified without acknowledging a hidden completion', () => {
  const source = {
    getStatusSnapshot: () => [
      {
        paneKey: 'runtime:a|tab:leaf',
        state: 'done' as const,
        completionIdentity: 'turn-a',
        prompt: '',
        connectionId: null,
        receivedAt: 1000,
        stateStartedAt: 1000
      },
      {
        paneKey: 'runtime:b|tab:leaf',
        state: 'done' as const,
        completionIdentity: 'turn-b',
        prompt: '',
        connectionId: null,
        receivedAt: 1000,
        stateStartedAt: 1000
      }
    ],
    subscribeStatusRowMutations: () => () => {}
  }
  const service = new NotchStatusService({ source })
  service.start()
  service.setViewedPanes(['runtime:a|tab:leaf'])
  expect(service.getSummary().counts).toEqual({ working: 0, attention: 0, done: 1 })
  service.setViewedPanes([])
  expect(service.getSummary().counts).toEqual({ working: 0, attention: 0, done: 2 })
  service.setViewedPanes(['runtime:a|tab:leaf'])
  service.stop()
  service.start()
  expect(service.getSummary().counts.done).toBe(2)
  service.acknowledgePanes([
    { paneKey: 'runtime:a|tab:leaf', stateStartedAt: 1000, observedAt: 1001 }
  ])
  service.setViewedPanes(['runtime:a|tab:leaf'])
  service.setViewedPanes([])
  expect(service.getSummary().counts.done).toBe(1)
  service.stop()
})

it('rejects a delayed read of an older local or remote completion', () => {
  const local = {
    paneKey: 'local-tab:leaf',
    state: 'done' as const,
    prompt: '',
    connectionId: null,
    receivedAt: 1000,
    stateStartedAt: 1000
  }
  const frame = {
    worktree: 'repo:main',
    tabs: [
      {
        type: 'terminal',
        parentTabId: 'remote-tab',
        leafId: '23456789-abcd-4abc-a123-123456789abc',
        agentStatus: {
          state: 'done',
          updatedAt: 9_000_000,
          stateStartedAt: 8_000_000,
          turnStartedAt: 7_000_000
        }
      }
    ]
  }
  const remoteKey = 'runtime:peer|remote-tab:23456789-abcd-4abc-a123-123456789abc'
  let rows = [local, ...notchRemoteSessionRows('peer', frame, new Map(), 1000, 'runtime/pairing')]
  let changed = (): void => {}
  const service = new NotchStatusService({
    source: {
      getStatusSnapshot: () => rows,
      subscribeStatusRowMutations: (listener) => {
        changed = listener
        return () => {}
      }
    },
    scheduleFlush: (flush) => {
      flush()
      return () => {}
    }
  })
  service.start()
  const oldReads = [
    { paneKey: local.paneKey, stateStartedAt: 1000, observedAt: 1001 },
    { paneKey: remoteKey, stateStartedAt: 8_000_000, turnStartedAt: 7_000_000, observedAt: 1001 }
  ]
  frame.tabs[0].agentStatus = {
    state: 'done',
    updatedAt: 9_000_100,
    stateStartedAt: 8_000_100,
    turnStartedAt: 7_000_100
  }
  rows = [
    { ...local, stateStartedAt: 2000 },
    ...notchRemoteSessionRows('peer', frame, new Map(), 2000, 'runtime/pairing')
  ]
  changed()
  service.acknowledgePanes(oldReads)
  expect(service.getSummary().counts.done).toBe(2)
  const currentReads = [
    { paneKey: local.paneKey, stateStartedAt: 2000, observedAt: 2001 },
    { paneKey: remoteKey, stateStartedAt: 8_000_100, turnStartedAt: 7_000_100, observedAt: 2001 }
  ]
  service.acknowledgePanes(currentReads)
  expect(service.getSummary().counts.done).toBe(0)
  frame.tabs[0].agentStatus = {
    state: 'done',
    updatedAt: 9_000_200,
    stateStartedAt: 8_000_100,
    turnStartedAt: 7_000_200
  }
  rows = [
    { ...local, stateStartedAt: 2000 },
    ...notchRemoteSessionRows('peer', frame, new Map(), 3000, 'runtime/pairing')
  ]
  changed()
  service.acknowledgePanes(currentReads)
  expect(service.getSummary().counts.done).toBe(1)
  service.acknowledgePanes([
    { paneKey: remoteKey, stateStartedAt: 8_000_100, turnStartedAt: 7_000_200, observedAt: 3001 }
  ])
  expect(service.getSummary().counts.done).toBe(0)
  service.stop()
})

it('persists only accepted local completion identities across cold start', () => {
  const paneKey = 'local-tab:leaf'
  let row = {
    paneKey,
    state: 'done' as const,
    prompt: '',
    connectionId: null,
    receivedAt: 1000,
    stateStartedAt: 1000,
    turnStartedAt: 900
  }
  let changed = (): void => {}
  let serialized = '{}'
  const source = {
    getStatusSnapshot: () => [row],
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
  const readA = { paneKey, stateStartedAt: 1000, turnStartedAt: 900, observedAt: 1001 }
  row = { ...row, receivedAt: 2000, stateStartedAt: 2000, turnStartedAt: 1900 }
  changed()
  first.acknowledgePanes([readA])
  expect(first.getSummary().counts.done).toBe(1)
  expect(JSON.parse(serialized)).toEqual({})
  first.stop()

  // A delayed renderer read can persist a generic UI stamp later than completion B.
  const coldStart = {
    source,
    scheduleFlush,
    acknowledgedAtByPaneKey: { [paneKey]: 3000 },
    acknowledgedCompletions: JSON.parse(serialized),
    onAcknowledgedCompletionsChanged: (completions: Readonly<Record<string, string>>) => {
      serialized = JSON.stringify(completions)
    }
  }
  const restored = new NotchStatusService(coldStart)
  restored.start()
  expect(restored.getSummary().counts.done).toBe(1)
  restored.acknowledgePanes([
    { paneKey, stateStartedAt: 2000, turnStartedAt: 1900, observedAt: 3001 }
  ])
  expect(restored.getSummary().counts.done).toBe(0)
  expect(JSON.parse(serialized)).toEqual({ [paneKey]: 'local:[2000,1900]' })
  restored.stop()

  const readRestored = new NotchStatusService({
    ...coldStart,
    acknowledgedCompletions: JSON.parse(serialized)
  })
  readRestored.start()
  expect(readRestored.getSummary().counts.done).toBe(0)
  row = { ...row, receivedAt: 4000, stateStartedAt: 4000, turnStartedAt: 3900 }
  changed()
  expect(readRestored.getSummary().counts.done).toBe(1)
  row = { ...row, stateStartedAt: 2000, turnStartedAt: 3950 }
  changed()
  expect(readRestored.getSummary().counts.done).toBe(1)
  readRestored.stop()
})
