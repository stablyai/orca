// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { makeAgentStatusEntry } from '../runtime/sync-runtime-graph/testing/sync-runtime-graph-test-harness'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph/graph-sync-scheduler'
import { useRuntimeGraphSync } from './use-runtime-graph-sync'

vi.mock('../runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: vi.fn(),
  setRuntimeGraphStoreStateGetter: vi.fn(),
  setRuntimeGraphSyncEnabled: vi.fn()
}))
const initialState = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})
// Same-bucket heartbeats change no mobile data; a state transition requires one publication.
describe('runtime graph heartbeat publication contract', () => {
  it.each([50, 500])('does not schedule heartbeats at %i panes', (count) => {
    useAppStore.setState(initialState, true)
    const entries = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const paneKey = `tab-${index}:11111111-1111-4111-8111-111111111111`
        return [
          paneKey,
          makeAgentStatusEntry({ paneKey, updatedAt: 1_800_000, stateStartedAt: 1_800_000 })
        ]
      })
    )
    useAppStore.setState({ agentStatusByPaneKey: entries })
    renderHook(() => useRuntimeGraphSync())
    vi.mocked(scheduleRuntimeGraphSync).mockClear()
    const key = Object.keys(entries)[9]
    for (let tick = 1; tick <= 20; tick += 1) {
      act(() =>
        useAppStore.setState({
          agentStatusByPaneKey: {
            ...useAppStore.getState().agentStatusByPaneKey,
            [key]: { ...entries[key], updatedAt: 1_800_000 + tick * 1_000 }
          }
        })
      )
      expect(scheduleRuntimeGraphSync).toHaveBeenCalledTimes(0)
    }
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...useAppStore.getState().agentStatusByPaneKey,
          [key]: { ...useAppStore.getState().agentStatusByPaneKey[key], state: 'blocked' }
        }
      })
    )
    expect(scheduleRuntimeGraphSync).toHaveBeenCalledTimes(1)
  })
})
