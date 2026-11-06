import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMobileSessionTabsAgentStatusHeartbeat,
  SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS
} from './mobile-session-tabs-agent-status-heartbeat'

describe('mobile session-tabs agent-status heartbeat', () => {
  const worktreesByPtyId = new Map<string, string[]>()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    worktreesByPtyId.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('deduplicates sibling PTYs because one snapshot refreshes their worktree', () => {
    const emitted: string[] = []
    worktreesByPtyId.set('pty-1', ['worktree-1'])
    worktreesByPtyId.set('pty-2', ['worktree-1'])
    const heartbeat = createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => worktreesByPtyId.get(ptyId) ?? [],
      (worktreeId) => emitted.push(worktreeId)
    )
    heartbeat.observeSemanticTitle('pty-1')
    heartbeat.observeSemanticTitle('pty-2')
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)

    heartbeat.scheduleDecorativeHeartbeat('pty-1')
    heartbeat.scheduleDecorativeHeartbeat('pty-2')
    heartbeat.removePty('pty-1')
    vi.runAllTimers()

    expect(emitted).toEqual(['worktree-1'])
  })

  it('keeps a direct status heartbeat queued when an unrelated PTY is removed', () => {
    const emitted: string[] = []
    const heartbeat = createMobileSessionTabsAgentStatusHeartbeat(
      () => [],
      (worktreeId) => emitted.push(worktreeId)
    )

    heartbeat.scheduleWorktreeHeartbeat('worktree-1')
    heartbeat.removePty('unrelated-pty')
    vi.runAllTimers()

    expect(emitted).toEqual(['worktree-1'])
    heartbeat.dispose()
  })
})
