// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { getDefaultSettings } from '../../../shared/constants'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-freshness'
import { createFreshnessScheduler } from '@/store/slices/agent-status/agent-status-freshness-scheduler'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'

const initialEntries: Record<string, AgentStatusEntry> = {}
const store = createStore(() => ({
  settings: { ...getDefaultSettings('/tmp'), holdQuitWhileAgentsWork: true },
  agentStatusByPaneKey: initialEntries,
  agentStatusEpoch: 0
}))
vi.mock('@/store', () => ({ useAppStore: store }))
const { useHoldQuitActivity } = await import('./use-hold-quit-activity')
const originalApi = window.api
afterEach(() => {
  cleanup()
  window.api = originalApi
  resetRendererAppPlatformCacheForTests()
  vi.useRealTimers()
})

it('publishes silent remote expiry through the existing status scheduler without new polling', () => {
  vi.useFakeTimers()
  const publish = vi.fn()
  Object.assign(window, {
    api: {
      platform: { get: () => ({ platform: 'darwin' }) },
      ui: { setHoldQuitActivity: publish }
    }
  })
  const now = Date.now()
  const entries: Record<string, AgentStatusEntry> = {
    remote: {
      paneKey: 'remote',
      state: 'working',
      prompt: 'Remote turn',
      updatedAt: now + 500_000,
      mirroredEvidenceReceivedAt: now,
      stateStartedAt: now,
      stateHistory: []
    }
  }
  store.setState({ agentStatusByPaneKey: entries, agentStatusEpoch: 0 })
  const scheduler = createFreshnessScheduler({
    getStatusEntries: () => store.getState().agentStatusByPaneKey,
    bumpEpochs: () => store.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
  })
  renderHook(useHoldQuitActivity)
  scheduler.schedule()
  expect(publish).toHaveBeenLastCalledWith(true)
  act(() => vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1))
  expect(store.getState().agentStatusByPaneKey).toBe(entries)
  expect(publish).toHaveBeenLastCalledWith(false)
  scheduler.dispose()
})
