import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { localDesktopSession } from '../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { GIT_KEY } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  shouldWatchLayoutRoundTrip,
  watchLayoutRoundTrip
} from './workspace-layout-round-trip-watch'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function watched(initial: WorkspaceSessionState) {
  let session = initial
  const listeners = new Set<() => void>()
  const stop = watchLayoutRoundTrip({
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
    onWorkspaceSessionWritten: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
  return {
    stop,
    write(next: WorkspaceSessionState) {
      session = next
      listeners.forEach((listener) => listener())
    }
  }
}

describe('the round-trip watch on Store writes', () => {
  it('runs only in dev, e2e or when asked', () => {
    expect(shouldWatchLayoutRoundTrip({ NODE_ENV: 'production' })).toBe(false)
    expect(shouldWatchLayoutRoundTrip({ NODE_ENV: 'development' })).toBe(true)
    expect(shouldWatchLayoutRoundTrip({ ORCA_E2E_USER_DATA_DIR: '/e2e' })).toBe(true)
    expect(shouldWatchLayoutRoundTrip({ ORCA_LAYOUT_ROUND_TRIP_CHECK: '1' })).toBe(true)
  })

  it('checks a settled burst once, logs findings by kind, and skips unchanged partitions', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { write, stop } = watched(localDesktopSession())
    const corrupt = localDesktopSession()
    corrupt.tabsByWorktree[GIT_KEY] = JSON.parse('[null]')
    write(corrupt)
    write(corrupt)
    vi.runAllTimers()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual([
      '[workspace-layout] round-trip check:',
      'local',
      [{ kind: 'threw', message: expect.any(String) }]
    ])
    write(corrupt)
    vi.runAllTimers()
    write(localDesktopSession())
    vi.runAllTimers()
    expect(warn).toHaveBeenCalledTimes(1)
    stop()
  })
})
