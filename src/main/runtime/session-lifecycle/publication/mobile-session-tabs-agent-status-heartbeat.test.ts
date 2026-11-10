import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'

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
