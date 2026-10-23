import {
  createHarness as createPushHarness,
  registration,
  flush
} from '../runtime/push/push-dispatcher.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { NOTIFICATION_COOLDOWN_MS } from '../../shared/notification-burst-cooldown'
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
    bringToFrontOnAgentTaskComplete: false,
    terminalBell: true,
    suppressWhenFocused: false,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 1,
    mutedNotificationSourceIds: [],
    notifyHiddenWorkspaces: true,
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

  it('skips the desktop banner for a muted machine but still reaches the phone', () => {
    const harness = makeHarness(makeSettings({ mutedNotificationSourceIds: ['runtime:m4air'] }))
    const service = createNotificationDeliveryService(harness.deps)

    expect(service.dispatch(makeRequest({ notificationSourceId: 'runtime:m4air' }))).toEqual({
      delivered: false,
      reason: 'host-muted'
    })
    expect(harness.dispatchMobileNotification).toHaveBeenCalledWith(
      expect.not.objectContaining({ desktopAllowed: false })
    )
    expect(harness.deliverNative).not.toHaveBeenCalled()

    // Other machines, and requests whose machine is unknown, still notify.
    expect(
      service.dispatch(
        makeRequest({ notificationSourceId: 'local', worktreeId: 'wt-2', worktreeLabel: 'wt-2' })
      )
    ).toEqual({ delivered: true })
    expect(service.dispatch(makeRequest({ worktreeId: 'wt-3', worktreeLabel: 'wt-3' }))).toEqual({
      delivered: true
    })
  })

  it('reports the master switch over a muted machine', () => {
    const harness = makeHarness(
      makeSettings({ enabled: false, mutedNotificationSourceIds: ['runtime:m4air'] })
    )
    expect(
      createNotificationDeliveryService(harness.deps).dispatch(
        makeRequest({ notificationSourceId: 'runtime:m4air' })
      )
    ).toEqual({ delivered: false, reason: 'disabled' })
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

  it('lets keyed news through the workspace window, collapsing only its own repeat', () => {
    const harness = makeHarness(makeSettings())
    const service = createNotificationDeliveryService(harness.deps)
    expect(service.dispatch(makeRequest())).toEqual({ delivered: true })
    const prompt = (attentionKey: string) => makeRequest({ agentState: 'blocked', attentionKey })
    expect(service.dispatch(prompt('p1'))).toEqual({ delivered: true })
    expect(service.dispatch(prompt('p2'))).toEqual({ delivered: true })
    expect(service.dispatch(prompt('p2'))).toEqual({ delivered: false, reason: 'cooldown' })
    expect(harness.dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({ attentionKey: 'p1', agentState: 'blocked' })
    )
  })

  it('leaves the phone to the execution host when it already pushed', () => {
    const harness = makeHarness(makeSettings())
    const service = createNotificationDeliveryService(harness.deps)
    expect(service.dispatch(makeRequest({ mobileDeliveredByHost: true }))).toEqual({
      delivered: true
    })
    expect(harness.dispatchMobileNotification).not.toHaveBeenCalled()
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

it.each<Partial<NotificationSettings>>([{}, { enabled: false }, { agentTaskComplete: false }])(
  'preserves mobile event content and push eligibility when a machine is muted (%j)',
  async (overrides) => {
    const events: Parameters<
      NonNullable<NotificationDeliveryDependencies['dispatchMobileNotification']>
    >[0][] = []
    for (const muted of [false, true]) {
      const push = createPushHarness({
        devices: [{ deviceId: 'phone', pushRegistration: registration() }]
      })
      const harness = makeHarness(
        makeSettings({ ...overrides, mutedNotificationSourceIds: muted ? ['runtime:qa'] : [] })
      )
      harness.deps.dispatchMobileNotification = (event) => {
        events.push(event)
        push.dispatcher.enqueue({ ...event, notificationSeq: 1, notificationEpoch: 'epoch' })
      }
      createNotificationDeliveryService(harness.deps).dispatch(
        makeRequest({ notificationSourceId: 'runtime:qa', agentState: 'done' })
      )
      await flush()
      expect(push.sends).toHaveLength(
        overrides.enabled === false || overrides.agentTaskComplete === false ? 0 : 1
      )
    }
    expect(events[1]).toEqual(events[0])
  }
)

it('changing a machine mute preserves mobile cooldown and does not reserve desktop cooldown', () => {
  const settings = makeSettings({ mutedNotificationSourceIds: ['runtime:qa'] })
  const harness = makeHarness(settings)
  const service = createNotificationDeliveryService(harness.deps)
  const request = makeRequest({ notificationSourceId: 'runtime:qa' })
  expect(service.dispatch(request)).toEqual({ delivered: false, reason: 'host-muted' })
  settings.mutedNotificationSourceIds = []
  expect(service.dispatch(request)).toEqual({ delivered: true })
  expect(harness.dispatchMobileNotification).toHaveBeenCalledTimes(1)
})

it('reports a muted host before a disabled source', () => {
  const harness = makeHarness(
    makeSettings({ agentTaskComplete: false, mutedNotificationSourceIds: ['runtime:qa'] })
  )
  expect(
    createNotificationDeliveryService(harness.deps).dispatch(
      makeRequest({ notificationSourceId: 'runtime:qa' })
    )
  ).toEqual({ delivered: false, reason: 'host-muted' })
})

it("tells the phone which server runs the workspace, through the gateway's push", async () => {
  for (const executionHost of [undefined, 'runtime:qa'] as const) {
    const push = createPushHarness({
      devices: [{ deviceId: 'phone', pushRegistration: registration() }]
    })
    const harness = makeHarness(makeSettings())
    harness.deps.dispatchMobileNotification = (event) =>
      push.dispatcher.enqueue({ ...event, notificationSeq: 1, notificationEpoch: 'epoch' })
    createNotificationDeliveryService(harness.deps).dispatch(
      makeRequest({ agentState: 'done', ...(executionHost ? { executionHost } : {}) })
    )
    await flush()
    expect(push.sends[0]?.notification.worktreeId).toBe('wt-1')
    expect(push.sends[0]?.notification.executionHost).toBe(executionHost)
  }
})

describe('bringing forward only an eligible completed reply', () => {
  function background(harness: Harness) {
    let focused = false
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The injected policy only reads focus and destruction, never constructs an Electron window.
    const window = {
      isFocused: () => focused,
      isDestroyed: () => false
    } as unknown as BrowserWindow
    harness.deps.findActiveWindow = () => window
    harness.deps.platform = 'darwin'
    harness.deps.bringSubjectToFront = vi.fn()
    harness.deps.canBringAgentReply = vi.fn(() => true)
    return {
      focus: () => {
        focused = true
      }
    }
  }
  it('S1: reveals the same subject, without waiting to deliver its banner', async () => {
    const harness = makeHarness(makeSettings({ bringToFrontOnAgentTaskComplete: true }))
    background(harness)
    const waiting = Promise.withResolvers<boolean>()
    harness.deps.canBringAgentReply = () => waiting.promise
    const request = makeRequest({ paneKey: 'invented-pane' })
    expect(await createNotificationDeliveryService(harness.deps).dispatch(request)).toEqual({
      delivered: true
    })
    expect(harness.deliverNative).toHaveBeenCalledOnce()
    expect(harness.deps.bringSubjectToFront).not.toHaveBeenCalled()
    waiting.resolve(true)
    await flush()
    expect(harness.deps.bringSubjectToFront).toHaveBeenCalledWith(request)
  })
  type RevealSetup = {
    settings: NotificationSettings
    harness: Harness
    window: ReturnType<typeof background>
    service: ReturnType<typeof createNotificationDeliveryService>
  }
  it.each<{
    gate: string
    setup: (context: RevealSetup) => void | Promise<unknown>
    request?: Partial<NotificationDispatchRequest>
  }>([
    {
      gate: 'disabled',
      setup: ({ settings }) => {
        settings.bringToFrontOnAgentTaskComplete = false
      }
    },
    {
      gate: 'linux',
      setup: ({ harness }) => {
        harness.deps.platform = 'linux'
      }
    },
    { gate: 'bell', setup: () => {}, request: { source: 'terminal-bell' } },
    { gate: 'focused', setup: ({ window }) => window.focus() },
    {
      gate: 'cooldown',
      setup: ({ service }) => service.dispatch(makeRequest({ source: 'terminal-bell' }))
    }
  ])('S2/S12: $gate does not read provenance', async ({ setup, request }) => {
    const settings = makeSettings({ bringToFrontOnAgentTaskComplete: true })
    const harness = makeHarness(settings)
    const window = background(harness)
    const service = createNotificationDeliveryService(harness.deps)
    await setup({ settings, harness, window, service })
    await service.dispatch(makeRequest(request))
    await flush()
    expect(harness.deps.canBringAgentReply).not.toHaveBeenCalled()
    expect(harness.deps.bringSubjectToFront).not.toHaveBeenCalled()
  })
  it.each<{
    reason: string
    eligible: boolean
    setup: (context: RevealSetup) => void
  }>([
    { reason: 'ineligible', eligible: false, setup: () => {} },
    { reason: 'focus', eligible: true, setup: ({ window }) => window.focus() },
    {
      reason: 'setting-off',
      eligible: true,
      setup: ({ settings }) => {
        settings.bringToFrontOnAgentTaskComplete = false
      }
    },
    {
      reason: 'current-turn',
      eligible: true,
      setup: ({ harness }) => {
        harness.deps.isAgentReplyCurrent = () => false
      }
    }
  ])('keeps banners and rejects a late reveal after $reason', async ({ setup, eligible }) => {
    const settings = makeSettings({ bringToFrontOnAgentTaskComplete: true })
    const harness = makeHarness(settings)
    const window = background(harness)
    const waiting = Promise.withResolvers<boolean>()
    harness.deps.canBringAgentReply = () => waiting.promise
    const service = createNotificationDeliveryService(harness.deps)
    await service.dispatch(makeRequest())
    setup({ settings, harness, window, service })
    waiting.resolve(eligible)
    await flush()
    expect(harness.deliverNative).toHaveBeenCalledOnce()
    expect(harness.deps.bringSubjectToFront).not.toHaveBeenCalled()
  })
  it('rejects an old pending reveal after a newer completion passes the exact cooldown boundary', async () => {
    const harness = makeHarness(makeSettings({ bringToFrontOnAgentTaskComplete: true }))
    background(harness)
    const older = makeRequest({ paneKey: 'invented-pane' })
    const newer = makeRequest({ paneKey: 'invented-pane' })
    const pending = Promise.withResolvers<boolean>()
    harness.deps.canBringAgentReply = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(true)
    let current = older
    harness.deps.isAgentReplyCurrent = (request) => request === current
    const service = createNotificationDeliveryService(harness.deps)
    await expect(service.dispatch(older)).resolves.toEqual({ delivered: true })
    now += NOTIFICATION_COOLDOWN_MS - 1
    expect(service.dispatch(newer)).toEqual({ delivered: false, reason: 'cooldown' })
    expect(harness.deps.canBringAgentReply).toHaveBeenCalledTimes(1)
    now += 1
    current = newer
    await expect(service.dispatch(newer)).resolves.toEqual({ delivered: true })
    await flush()
    expect(harness.deps.bringSubjectToFront).toHaveBeenCalledExactlyOnceWith(newer)
    pending.resolve(true)
    await flush()
    expect(harness.deliverNative).toHaveBeenCalledTimes(2)
    expect(harness.deps.bringSubjectToFront).toHaveBeenCalledExactlyOnceWith(newer)
  })
})
