import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMobileSessionTabsAgentStatusHeartbeat,
  SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS,
  SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS
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

  it('refreshes continuously active PTYs through one globally capped FIFO', () => {
    const emitted: { worktreeId: string; at: number }[] = []
    const heartbeat = createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => worktreesByPtyId.get(ptyId) ?? [],
      (worktreeId) => emitted.push({ worktreeId, at: Date.now() })
    )
    const ptyIds = Array.from({ length: 24 }, (_, index) => `pty-${index}`)
    for (const ptyId of ptyIds) {
      worktreesByPtyId.set(ptyId, [ptyId.replace('pty', 'worktree')])
      heartbeat.observeSemanticTitle(ptyId)
    }

    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS - 1)
    for (const ptyId of ptyIds) {
      heartbeat.scheduleDecorativeHeartbeat(ptyId)
    }
    vi.runOnlyPendingTimers()
    expect(emitted).toEqual([])

    vi.advanceTimersByTime(1)
    for (const ptyId of ptyIds) {
      heartbeat.scheduleDecorativeHeartbeat(ptyId)
    }
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS * (ptyIds.length - 1))

    expect(emitted.map(({ worktreeId }) => worktreeId)).toEqual(
      ptyIds.map((ptyId) => ptyId.replace('pty', 'worktree'))
    )
    for (let index = 1; index < emitted.length; index += 1) {
      expect(emitted[index]!.at - emitted[index - 1]!.at).toBeGreaterThanOrEqual(
        SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS
      )
    }
    for (const ptyId of ptyIds) {
      heartbeat.scheduleDecorativeHeartbeat(ptyId)
    }
    vi.runOnlyPendingTimers()
    expect(emitted).toHaveLength(ptyIds.length)
    heartbeat.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets semantic transitions bypass and cancel queued heartbeats', () => {
    const emitted: string[] = []
    worktreesByPtyId.set('pty-1', ['worktree-1'])
    worktreesByPtyId.set('pty-2', ['worktree-2'])
    const heartbeat = createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => worktreesByPtyId.get(ptyId) ?? [],
      (worktreeId) => emitted.push(worktreeId)
    )
    heartbeat.observeSemanticTitle('pty-1')
    heartbeat.observeSemanticTitle('pty-2')
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)

    heartbeat.scheduleDecorativeHeartbeat('pty-1')
    heartbeat.scheduleDecorativeHeartbeat('pty-2')
    heartbeat.observeSemanticTitle('pty-2')
    vi.runAllTimers()

    expect(emitted).toEqual(['worktree-1'])
    heartbeat.removePty('pty-1')
    heartbeat.removePty('pty-2')
    expect(vi.getTimerCount()).toBe(0)
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

  it('does not slip spacing-delayed worktrees to the next stale boundary', () => {
    const emitted: { worktreeId: string; at: number }[] = []
    worktreesByPtyId.set('pty-1', ['worktree-1'])
    worktreesByPtyId.set('pty-2', ['worktree-2'])
    const heartbeat = createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => worktreesByPtyId.get(ptyId) ?? [],
      (worktreeId) => emitted.push({ worktreeId, at: Date.now() })
    )
    heartbeat.observeSemanticTitle('pty-1')
    heartbeat.observeSemanticTitle('pty-2')

    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)
    heartbeat.scheduleDecorativeHeartbeat('pty-1')
    heartbeat.scheduleDecorativeHeartbeat('pty-2')
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS)
    expect(emitted).toEqual([
      { worktreeId: 'worktree-1', at: SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS },
      {
        worktreeId: 'worktree-2',
        at:
          SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS +
          SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS
      }
    ])

    vi.advanceTimersByTime(
      SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS -
        SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS
    )
    heartbeat.scheduleDecorativeHeartbeat('pty-1')
    heartbeat.scheduleDecorativeHeartbeat('pty-2')
    vi.runOnlyPendingTimers()
    expect(emitted.at(-1)).toEqual({
      worktreeId: 'worktree-1',
      at: SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS * 2
    })

    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS - 1)
    heartbeat.scheduleDecorativeHeartbeat('pty-2')
    vi.runOnlyPendingTimers()
    expect(emitted).toHaveLength(3)

    vi.advanceTimersByTime(1)
    heartbeat.scheduleDecorativeHeartbeat('pty-2')
    vi.runOnlyPendingTimers()
    expect(emitted.at(-1)).toEqual({
      worktreeId: 'worktree-2',
      at:
        SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS * 2 +
        SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS
    })
  })

  it('drops removed worktrees and pending work during teardown', () => {
    const emitted: string[] = []
    worktreesByPtyId.set('pty-1', ['worktree-1'])
    worktreesByPtyId.set('pty-2', ['worktree-2'])
    const heartbeat = createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => worktreesByPtyId.get(ptyId) ?? [],
      (worktreeId) => emitted.push(worktreeId)
    )
    heartbeat.observeSemanticTitle('pty-1')
    heartbeat.observeSemanticTitle('pty-2')
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)
    heartbeat.scheduleDecorativeHeartbeat('pty-1')
    expect(vi.getTimerCount()).toBe(1)
    heartbeat.removePty('pty-1')
    vi.runAllTimers()
    expect(emitted).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    heartbeat.scheduleDecorativeHeartbeat('pty-2')
    expect(vi.getTimerCount()).toBe(1)
    heartbeat.removeWorktree('worktree-2')
    expect(vi.getTimerCount()).toBe(0)

    heartbeat.scheduleDecorativeHeartbeat('pty-1')
    expect(vi.getTimerCount()).toBe(1)
    heartbeat.cancelPending()
    expect(vi.getTimerCount()).toBe(0)
    heartbeat.scheduleDecorativeHeartbeat('pty-1')
    heartbeat.dispose()
    vi.runAllTimers()
    expect(emitted).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
