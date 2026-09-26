import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createNotificationDeliveryService } from './notification-delivery-service'
import type { NotificationDeliveryDependencies } from './notification-delivery-service'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import {
  createHarness as createPushHarness,
  registration,
  flush
} from '../runtime/push/push-dispatcher.test-fixture'
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
  it('keeps requests without workspace origin enabled when both provenance settings are off', () => {
    const harness = makeHarness(
      makeSettings({ cliWorktreeTaskComplete: false, automationWorktreeTaskComplete: false })
    )
    expect(createNotificationDeliveryService(harness.deps).dispatch(makeRequest())).toEqual({
      delivered: true
    })
    expect(harness.dispatchMobileNotification).toHaveBeenCalledWith(
      expect.not.objectContaining({ desktopAllowed: false })
    )
  })

  it.each(['blocked', 'waiting'] as const)(
    'preserves %s attention banners and phone pushes when provenance completions are muted',
    async (agentState) => {
      const harness = makeHarness(
        makeSettings({ cliWorktreeTaskComplete: false, automationWorktreeTaskComplete: false })
      )
      const controller = new RuntimeMobileNotificationController()
      const push = createPushHarness({
        devices: [{ deviceId: 'phone', pushRegistration: registration() }]
      })
      controller.onDispatched((event) => push.dispatcher.enqueue(event))
      harness.deps.dispatchMobileNotification = (event) => controller.dispatch(event)
      const service = createNotificationDeliveryService(harness.deps)
      for (const workspaceOrigin of ['cli', 'automation'] as const) {
        now += 60_000
        expect(service.dispatch(makeRequest({ workspaceOrigin, agentState }))).toEqual({
          delivered: true
        })
      }
      await flush()
      expect(push.sends).toHaveLength(2)
      expect(push.sends[0].notification.agentState).toBe('needs-input')
    }
  )

  it('keeps muted completions out of the push gateway and legacy socket alerts without suppressing later ordinary completions', async () => {
    const harness = makeHarness(makeSettings({ cliWorktreeTaskComplete: false }))
    const controller = new RuntimeMobileNotificationController()
    const push = createPushHarness({
      devices: [{ deviceId: 'phone', pushRegistration: registration() }]
    })
    controller.onDispatched((event) => push.dispatcher.enqueue(event))
    harness.deps.dispatchMobileNotification = (event) => controller.dispatch(event)
    const service = createNotificationDeliveryService(harness.deps)
    service.dispatch(makeRequest({ workspaceOrigin: 'cli' }))
    await flush()
    expect(push.sends).toHaveLength(0)
    expect(controller.getMissedSince(0)[0]).toMatchObject({
      desktopAllowed: false,
      legacySocketAllowed: false
    })
    service.dispatch(makeRequest())
    await flush()
    expect(push.sends).toHaveLength(1)
    expect(harness.deliverNative).toHaveBeenCalledTimes(1)
  })

  it.each(['cli', 'automation', 'other', undefined] as const)(
    'keeps the master switch authoritative for %s and old settings enabled',
    (workspaceOrigin) => {
      const enabled = makeHarness(makeSettings())
      expect(
        createNotificationDeliveryService(enabled.deps).dispatch(makeRequest({ workspaceOrigin }))
      ).toEqual({ delivered: true })
      const muted = makeHarness(
        makeSettings({
          agentTaskComplete: false,
          cliWorktreeTaskComplete: true,
          automationWorktreeTaskComplete: true
        })
      )
      expect(
        createNotificationDeliveryService(muted.deps).dispatch(makeRequest({ workspaceOrigin }))
      ).toEqual({ delivered: false, reason: 'source-disabled' })
    }
  )

  it.each(['cli', 'automation'] as const)(
    'does not apply the %s completion setting to terminal bells',
    (workspaceOrigin) => {
      const harness = makeHarness(
        makeSettings({ cliWorktreeTaskComplete: false, automationWorktreeTaskComplete: false })
      )
      expect(
        createNotificationDeliveryService(harness.deps).dispatch(
          makeRequest({ workspaceOrigin, source: 'terminal-bell' })
        )
      ).toEqual({ delivered: true })
    }
  )

  it.each(['cli', 'automation'] as const)(
    'mutes %s banners and push eligibility but preserves tray attention',
    (workspaceOrigin) => {
      const harness = makeHarness(
        makeSettings({
          cliWorktreeTaskComplete: false,
          automationWorktreeTaskComplete: false
        })
      )
      const result = createNotificationDeliveryService(harness.deps).dispatch(
        makeRequest({ workspaceOrigin })
      )
      expect(result).toEqual({ delivered: false, reason: 'source-disabled' })
      expect(harness.deliverNative).not.toHaveBeenCalled()
      expect(harness.setTrayAttention).toHaveBeenCalledWith(true)
      expect(harness.dispatchMobileNotification).toHaveBeenCalledWith(
        expect.objectContaining({ desktopAllowed: false })
      )
    }
  )

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
