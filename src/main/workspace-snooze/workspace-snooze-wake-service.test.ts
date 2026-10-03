import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishSystemResume, publishSystemSuspend } from '../system-power-lifecycle'
import { WorkspaceSnoozeWakeService, type SnoozedWorkspace } from './workspace-snooze-wake-service'

const TICK_MS = 1000

function createHarness(initial: SnoozedWorkspace[]) {
  let snoozed = [...initial]
  let now = 10_000
  const wake = vi.fn(async (workspace: SnoozedWorkspace) => {
    snoozed = snoozed.filter((item) => item.id !== workspace.id)
  })
  const service = new WorkspaceSnoozeWakeService({
    listSnoozed: () => snoozed,
    wake,
    now: () => now,
    tickMs: TICK_MS
  })
  return {
    service,
    wake,
    advance: (ms: number) => {
      now += ms
    }
  }
}

const due: SnoozedWorkspace = {
  kind: 'worktree',
  id: 'repo::/due',
  snooze: { snoozedAt: 0, wakeAt: 5_000 }
}
const later: SnoozedWorkspace = {
  kind: 'folder-workspace',
  id: 'folder-1',
  snooze: { snoozedAt: 0, wakeAt: 20_000 }
}

describe('WorkspaceSnoozeWakeService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    publishSystemResume()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes overdue workspaces on start without waiting for a tick', async () => {
    const { service, wake } = createHarness([due, later])
    service.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(due, 10_000)
    service.stop()
  })

  it('wakes a workspace on the first tick after its time passes', async () => {
    const { service, wake, advance } = createHarness([later])
    service.start()
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(wake).not.toHaveBeenCalled()

    advance(10_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(wake).toHaveBeenCalledWith(later, 20_000)
    service.stop()
  })

  it('catches up on resume from OS sleep', async () => {
    const { service, wake, advance } = createHarness([later])
    service.start()
    publishSystemSuspend()
    advance(60_000)
    publishSystemResume()
    await vi.advanceTimersByTimeAsync(0)

    expect(wake).toHaveBeenCalledWith(later, 70_000)
    service.stop()
  })

  it('never wakes a snooze with no wake time', async () => {
    const { service, wake } = createHarness([
      { kind: 'worktree', id: 'repo::/open-ended', snooze: { snoozedAt: 0 } }
    ])
    service.start()
    await vi.advanceTimersByTimeAsync(TICK_MS * 3)

    expect(wake).not.toHaveBeenCalled()
    service.stop()
  })

  it('keeps waking the rest when one wake fails, and retries it next pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second: SnoozedWorkspace = { ...due, id: 'repo::/second' }
    const { service, wake } = createHarness([due, second])
    wake.mockRejectedValueOnce(new Error('host unreachable'))
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(wake.mock.calls.map(([workspace]) => workspace.id)).toEqual([
      'repo::/due',
      'repo::/second'
    ])

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(wake.mock.calls.map(([workspace]) => workspace.id)).toEqual([
      'repo::/due',
      'repo::/second',
      'repo::/due'
    ])
    expect(warn).toHaveBeenCalledOnce()
    service.stop()
    warn.mockRestore()
  })

  it('warns instead of rejecting when listing fails, and retries next pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wake = vi.fn(async () => {})
    const listSnoozed = vi
      .fn<() => SnoozedWorkspace[]>()
      .mockImplementationOnce(() => {
        throw new Error('store unavailable')
      })
      .mockImplementation(() => [due])
    const service = new WorkspaceSnoozeWakeService({
      listSnoozed,
      wake,
      now: () => 10_000,
      tickMs: TICK_MS
    })

    await expect(service.wakeDue()).resolves.toBeUndefined()
    expect(wake).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()

    await service.wakeDue()
    expect(wake).toHaveBeenCalledWith(due, 10_000)
    warn.mockRestore()
  })

  it('coalesces calls made during a pass into one follow-up pass', async () => {
    const { service, wake } = createHarness([due])
    let release!: () => void
    // Leaves `due` listed, so the follow-up pass wakes it again and the call count shows the pass ran.
    wake.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const first = service.wakeDue()
    const second = service.wakeDue()
    const third = service.wakeDue()
    expect(second).toBe(first)
    expect(third).toBe(first)
    release()
    await first
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it('stops ticking after stop', async () => {
    const { service, wake, advance } = createHarness([later])
    service.start()
    service.stop()
    advance(60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS * 3)
    publishSystemResume()

    expect(wake).not.toHaveBeenCalled()
  })
})
