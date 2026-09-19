import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createNotificationDeliveryService } from './notification-delivery-service'
import type { NotificationDeliveryDependencies } from './notification-delivery-service'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'

function makeSettings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: true,
    suppressWhenFocused: false,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 1,
    ...overrides
  }
}

function makeRequest(
  overrides: Partial<NotificationDispatchRequest> = {}
): NotificationDispatchRequest {
  return {
    source: 'agent-task-complete',
    worktreeId: 'wt-1',
    worktreeLabel: 'wt-1',
    ...overrides
  }
}

type Harness = {
  deps: NotificationDeliveryDependencies
  order: string[]
  setTrayAttention: ReturnType<typeof vi.fn>
  dispatchMobileNotification: ReturnType<typeof vi.fn>
  deliverNative: ReturnType<typeof vi.fn>
}

let now = 1_000

/** The delivery policy only asks a window whether it is focused. */
function makeFocusedWindowStub(): BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only isFocused(); a full BrowserWindow cannot be constructed outside Electron.
  return { isFocused: () => true } as unknown as BrowserWindow
}

function makeHarness(settings: NotificationSettings, windowVisible = false): Harness {
  const order: string[] = []
  const setTrayAttention = vi.fn(() => order.push('tray'))
  const dispatchMobileNotification = vi.fn(() => order.push('mobile'))
  const deliverNative = vi.fn(() => {
    order.push('native')
    return { delivered: true } as const
  })
  return {
    order,
    setTrayAttention,
    dispatchMobileNotification,
    deliverNative,
    deps: {
      readNotificationSettings: () => settings,
      findActiveWindow: () => null,
      isWindowVisible: () => windowVisible,
      setTrayAttention,
      isNotificationSupported: () => true,
      dispatchMobileNotification,
      readAuthorizationStatus: () => Promise.resolve('authorized'),
      recordDeliveryOutcome: vi.fn(),
      deliverNative,
      platform: 'linux',
      now: () => now
    }
  }
}

beforeEach(() => {
  now += 60_000
})

describe('createNotificationDeliveryService', () => {
  it('lights the tray dot before the enabled/cooldown gates can reject the event', () => {
    const harness = makeHarness(makeSettings({ enabled: false }))
    const result = createNotificationDeliveryService(harness.deps).dispatch(makeRequest())

    expect(harness.setTrayAttention).toHaveBeenCalledWith(true)
    expect(result).toEqual({ delivered: false, reason: 'disabled' })
    expect(harness.deliverNative).not.toHaveBeenCalled()
    expect(harness.order[0]).toBe('tray')
  })

  it('leaves the tray dot alone while the window is visible', () => {
    const harness = makeHarness(makeSettings(), true)
    createNotificationDeliveryService(harness.deps).dispatch(makeRequest())
    expect(harness.setTrayAttention).not.toHaveBeenCalled()
  })

  it('fans out to mobile before the desktop-disabled early return', () => {
    const harness = makeHarness(makeSettings({ agentTaskComplete: false }))
    const result = createNotificationDeliveryService(harness.deps).dispatch(makeRequest())

    expect(result).toEqual({ delivered: false, reason: 'source-disabled' })
    expect(harness.dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({ desktopAllowed: false, source: 'agent-task-complete' })
    )
    expect(harness.order).toEqual(['tray', 'mobile'])
  })

  it('keeps the desktop source gates distinct per source', () => {
    const harness = makeHarness(makeSettings({ terminalBell: false }))
    const service = createNotificationDeliveryService(harness.deps)
    expect(service.dispatch(makeRequest({ source: 'terminal-bell' }))).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })
    expect(service.dispatch(makeRequest({ worktreeId: 'wt-2', worktreeLabel: 'wt-2' }))).toEqual({
      delivered: true
    })
  })

  it('suppresses a focused active workspace without touching mobile delivery', () => {
    const harness = makeHarness(makeSettings({ suppressWhenFocused: true }))
    const focusedWindow = makeFocusedWindowStub()
    harness.deps.findActiveWindow = () => focusedWindow
    const result = createNotificationDeliveryService(harness.deps).dispatch(
      makeRequest({ isActiveWorktree: true })
    )

    expect(result).toEqual({ delivered: false, reason: 'suppressed-focus' })
    expect(harness.dispatchMobileNotification).toHaveBeenCalledTimes(1)
  })

  it('dedupes desktop bursts per workspace but still reports the first delivery', () => {
    const harness = makeHarness(makeSettings())
    const service = createNotificationDeliveryService(harness.deps)
    expect(service.dispatch(makeRequest())).toEqual({ delivered: true })
    expect(service.dispatch(makeRequest({ source: 'terminal-bell' }))).toEqual({
      delivered: false,
      reason: 'cooldown'
    })
  })

  it('skips mobile fan-out entirely when no runtime is paired', () => {
    const harness = makeHarness(makeSettings())
    harness.deps.dispatchMobileNotification = null
    expect(createNotificationDeliveryService(harness.deps).dispatch(makeRequest())).toEqual({
      delivered: true
    })
    expect(harness.dispatchMobileNotification).not.toHaveBeenCalled()
  })

  describe('per-event mobile dedupe', () => {
    it('fans out once per completion even when the coarse burst key differs', () => {
      const harness = makeHarness(makeSettings())
      const service = createNotificationDeliveryService(harness.deps)
      const key = 'local\u0000session-1\u0000turn-1'

      // Two windows raise the SAME completion, and the coarse per-workspace gate cannot hold the
      // second: that key includes agentState, which the two windows read from their own row and
      // can disagree about. Only the event identity makes this one push rather than two.
      service.dispatch(makeRequest({ mobileDedupeKey: key, agentState: 'done' }))
      service.dispatch(makeRequest({ mobileDedupeKey: key, agentState: 'working' }))

      expect(harness.dispatchMobileNotification).toHaveBeenCalledTimes(1)
    })

    it('holds a repeat of one completion open-endedly, not for a burst window', () => {
      const harness = makeHarness(makeSettings())
      const service = createNotificationDeliveryService(harness.deps)
      const key = 'local\u0000session-1\u0000turn-1'

      service.dispatch(makeRequest({ mobileDedupeKey: key, agentState: 'done' }))
      // Long past the coarse burst window. The same completion is still the same completion.
      now += 60_000
      service.dispatch(makeRequest({ mobileDedupeKey: key, agentState: 'working' }))

      expect(harness.dispatchMobileNotification).toHaveBeenCalledTimes(1)
    })

    it('still fans out for a genuinely different completion', () => {
      const harness = makeHarness(makeSettings())
      const service = createNotificationDeliveryService(harness.deps)

      service.dispatch(makeRequest({ mobileDedupeKey: 'local\u0000session-1\u0000turn-1' }))
      service.dispatch(
        makeRequest({ mobileDedupeKey: 'local\u0000session-2\u0000turn-1', worktreeId: 'wt-2' })
      )

      expect(harness.dispatchMobileNotification).toHaveBeenCalledTimes(2)
    })
  })

  it('reports blocked-by-system on macOS when permission is undecided', async () => {
    const harness = makeHarness(makeSettings())
    harness.deps.platform = 'darwin'
    harness.deps.readAuthorizationStatus = () => Promise.resolve('not-determined')
    await expect(
      createNotificationDeliveryService(harness.deps).dispatch(makeRequest())
    ).resolves.toEqual({ delivered: false, reason: 'blocked-by-system' })
    expect(harness.deliverNative).not.toHaveBeenCalled()
  })
})
