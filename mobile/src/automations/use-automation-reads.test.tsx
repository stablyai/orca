import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAutomationRuns } from './use-automation-runs'
import { automationClient, savedRun } from './automation-test-fixtures'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})
function latest<T>(read: () => T | null) {
  const value = read()
  if (!value) {
    throw new Error('Not mounted')
  }
  return value
}

describe('host-owned automation reads', () => {
  it('never reports a selected run that a newer host sent unreadable as gone from history', async () => {
    const kept = { ...savedRun('kept'), createdAt: 2000 }
    const chosen = { ...savedRun('chosen'), createdAt: 1000 }
    let runs: unknown[] = [kept, chosen]
    const port = automationClient(() => ({ runs, nextCursor: null }))
    let state: ReturnType<typeof useAutomationRuns> | null = null
    let selected: ReturnType<typeof savedRun> | undefined
    function Probe({ revision }: { revision: number }) {
      state = useAutomationRuns(port.client, null, revision, true, selected)
      return null
    }
    const read = () => latest(() => state)
    await act(async () => {
      tree = create(createElement(Probe, { revision: 0 }))
    })
    selected = read().runs.find((run) => run.id === 'chosen')
    runs = [kept, { ...chosen, errorParams: { retryable: true } }]
    await act(async () => tree?.update(createElement(Probe, { revision: 1 })))
    expect(read().error).toBeNull()
    expect(read().unavailable).toBe(false)
    expect(read().selected?.outputSnapshot?.content).toBe('Output for chosen')
    runs = [kept]
    await act(async () => tree?.update(createElement(Probe, { revision: 2 })))
    expect(read().unavailable).toBe(true)
  })
})
