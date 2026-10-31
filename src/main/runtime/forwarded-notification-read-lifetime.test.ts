import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'

it('holds the saved forwarding environment across restart, applies reads without publication, and releases on quiet expiry', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'orca-forwarded-read-'))
  vi.useFakeTimers()
  const first = new RuntimeMobileNotificationController()
  const restarted = new RuntimeMobileNotificationController()
  const schedule = vi.spyOn(globalThis, 'setTimeout')
  const cancel = vi.spyOn(globalThis, 'clearTimeout')
  const errors: unknown[] = []
  try {
    first.configureDismissalStore(folder)
    const structuredOrigin = {
      scope: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'B-workspace',
        workspaceKind: 'folder' as const
      },
      sessionId: 'session',
      cause: { kind: 'prompt' as const, promptId: 'prompt' },
      journalCursor: { epoch: 'B-journal', sequence: 4 }
    }
    const alert = {
      type: 'notification' as const,
      source: 'agent-task-complete' as const,
      title: 'Orca',
      body: '',
      notificationId: 'prompt',
      structuredOrigin,
      forwardingEnvironmentId: 'A-environment-for-B'
    }
    first.dispatch(alert)
    const firstTimer = schedule.mock.results.at(-1)?.value
    expect(firstTimer).toBeDefined()
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 7 * 86400_000)
    expect(vi.getTimerCount()).toBe(1)
    await first.closeDismissals()
    expect(cancel).toHaveBeenLastCalledWith(firstTimer)
    expect(vi.getTimerCount()).toBe(0)
    restarted.configureDismissalStore(folder)
    const restoredTimer = schedule.mock.results.at(-1)?.value
    expect(restoredTimer).toBeDefined()
    expect(restoredTimer).not.toBe(firstTimer)
    expect(vi.getTimerCount()).toBe(1)
    expect(restarted.getForwardedEnvironments()).toEqual(['A-environment-for-B'])
    const replacementTimer = schedule.mock.results.at(-1)?.value
    expect(replacementTimer).toBeDefined()
    expect(replacementTimer).not.toBe(restoredTimer)
    expect(cancel).toHaveBeenLastCalledWith(restoredTimer)
    expect(vi.getTimerCount()).toBe(1)
    const events: MobileNotificationEvent[] = []
    restarted.onDispatched((event) => events.push(event))
    restarted.retireStructuredAttention({
      sessionId: 'session',
      observedCursor: structuredOrigin.journalCursor
    })
    expect(events.map((event) => event.type)).toEqual(['dismiss'])
    expect(cancel).toHaveBeenLastCalledWith(replacementTimer)
    expect(vi.getTimerCount()).toBe(0)
    expect(restarted.getForwardedEnvironments()).toEqual([])
    restarted.dispatch({ ...alert, notificationId: 'next' })
    const changes: string[][] = []
    restarted.onForwardedEnvironmentsChanged((environments) => changes.push(environments))
    await restarted.flushDismissals()
    await vi.advanceTimersByTimeAsync(7 * 86400_000)
    expect(changes).toEqual([[]])
    expect(vi.getTimerCount()).toBe(0)
    expect(restarted.getForwardedEnvironments()).toEqual([])
    restarted.dispatch({ ...alert, notificationId: 'live-close' })
    const liveTimer = schedule.mock.results.at(-1)?.value
    expect(liveTimer).toBeDefined()
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 7 * 86400_000)
    expect(vi.getTimerCount()).toBe(1)
    const beforeClose = changes.slice()
    const eventsBeforeClose = events.slice()
    await restarted.closeDismissals()
    expect(cancel).toHaveBeenLastCalledWith(liveTimer)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(7 * 86400_000)
    expect(changes).toEqual(beforeClose)
    expect(events).toEqual(eventsBeforeClose)
  } catch (error) {
    errors.push(error)
  } finally {
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => first.closeDismissals()),
      Promise.resolve().then(() => restarted.closeDismissals())
    ])
    for (const result of closed) {
      if (result.status === 'rejected') {
        errors.push(result.reason)
      }
    }
    schedule.mockRestore()
    cancel.mockRestore()
    vi.useRealTimers()
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Forwarded notification lifetime or cleanup failed')
  }
})

it.each([10, 100])(
  'does no projection for unrelated events and one for %s settled deliveries',
  async (count) => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-forwarded-perf-'))
    const controller = new RuntimeMobileNotificationController()
    const project = vi.spyOn(MobileNotificationDismissalStore.prototype, 'forwardedEnvironments')
    const structuredOrigin = {
      scope: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'B',
        workspaceKind: 'folder' as const
      },
      sessionId: 'session',
      cause: { kind: 'prompt' as const, promptId: 'prompt' },
      journalCursor: { epoch: 'journal', sequence: 4 }
    }
    try {
      controller.configureDismissalStore(folder)
      for (let i = 0; i < count; i++) {
        controller.dispatch({
          type: 'notification',
          source: 'agent-task-complete',
          title: 'Orca',
          body: '',
          notificationId: `prompt-${i}`,
          forwardingEnvironmentId: `environment-${i}`,
          structuredOrigin
        })
      }
      project.mockClear()
      for (let i = 0; i < count; i++) {
        controller.dispatch({ type: 'notification', source: 'plugin', title: 'Orca', body: '' })
      }
      expect(project).not.toHaveBeenCalled()
      controller.retireStructuredAttention({
        sessionId: 'session',
        observedCursor: { epoch: 'journal', sequence: 4 }
      })
      expect(project).toHaveBeenCalledTimes(1)
      expect(controller.getForwardedEnvironments()).toEqual([])
      project.mockClear()
      controller.retireStructuredAttention({
        sessionId: 'session',
        observedCursor: { epoch: 'journal', sequence: 4 }
      })
      expect(project).not.toHaveBeenCalled()
    } finally {
      await controller.closeDismissals()
      project.mockRestore()
      rmSync(folder, { recursive: true, force: true })
    }
  }
)

it('releases forwarded interest when an ordinary record evicts its last delivery', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'orca-forwarded-evict-'))
  const controller = new RuntimeMobileNotificationController()
  try {
    controller.configureDismissalStore(folder)
    controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Orca',
      body: '',
      notificationId: 'forwarded',
      forwardingEnvironmentId: 'B',
      structuredOrigin: {
        scope: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'B',
          workspaceKind: 'folder'
        },
        sessionId: 'session',
        cause: { kind: 'prompt', promptId: 'prompt' },
        journalCursor: { epoch: 'journal', sequence: 4 }
      }
    })
    const changes: string[][] = []
    controller.onForwardedEnvironmentsChanged((ids) => changes.push(ids))
    for (let i = 0; i < 4096; i++) {
      controller.dispatch({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Orca',
        body: '',
        notificationId: `ordinary-${i}`
      })
    }
    expect(changes).toEqual([[]])
  } finally {
    await controller.closeDismissals()
    rmSync(folder, { recursive: true, force: true })
  }
})
