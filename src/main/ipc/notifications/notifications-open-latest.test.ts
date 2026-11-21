import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  notificationClose: vi.fn(),
  notificationOn: vi.fn(),
  notificationOnce: vi.fn(),
  getTrustedUIRendererWindow: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: mocks.handle },
  Notification: class {
    static isSupported = (): boolean => true
    static remove = vi.fn()
    static removeGroup = vi.fn()
    show = vi.fn()
    close = mocks.notificationClose
    on = mocks.notificationOn
    once = mocks.notificationOnce
    removeListener = vi.fn()
    emit = vi.fn()
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { focus: vi.fn() },
  powerMonitor: {},
  shell: { openExternal: vi.fn() }
}))
// Linux submits a banner only after its D-Bus service answers.
vi.mock('@orca/process-host', () => ({ runProcess: () => Promise.resolve({ code: 0 }) }))
vi.mock('../ui', () => ({ getTrustedUIRendererWindow: mocks.getTrustedUIRendererWindow }))
vi.mock('./notification-authorization-status', () => ({
  readNotificationAuthorizationStatus: () => Promise.resolve(null)
}))
vi.mock('../../tray/system-tray', () => ({ setTrayAttention: vi.fn() }))
vi.mock('../../external-conversations/external-conversation-links', () => ({
  sessionRepliesInSlack: () => false
}))

import type { StructuredAttentionOrigin } from '../../../shared/agent-session/view/agent-session-attention'
import type { NotificationAttentionAcknowledgement } from '../../../shared/notifications/notification-settings-types'
import { registerNotificationHandlers } from './notifications'
import { hasOpenableNotification, openLatestNotification } from './openable-notifications'

const getTrustedUIRendererWindowMock = mocks.getTrustedUIRendererWindow
const notificationCloseMock = mocks.notificationClose

function resetNotificationDispatchMocks(): void {
  mocks.handle.mockReset()
  mocks.notificationClose.mockClear()
  mocks.notificationOn.mockClear()
  mocks.notificationOnce.mockClear()
  mocks.getTrustedUIRendererWindow.mockReset()
  mocks.getTrustedUIRendererWindow.mockReturnValue(null)
}

function registeredHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  return call[1]
}

function getDispatchHandler(): (event: unknown, args: unknown) => unknown {
  return registeredHandler('notifications:dispatch')
}

function getDismissHandler(): (event: unknown, ...args: unknown[]) => unknown {
  return registeredHandler('notifications:dismiss')
}

function getNotificationEventHandler(
  eventName: string,
  mock: ReturnType<typeof vi.fn> = mocks.notificationOn
): (...args: unknown[]) => void {
  const call = mock.mock.calls.find((c: unknown[]) => c[0] === eventName)
  if (!call) {
    throw new Error(`Notification ${eventName} handler not registered`)
  }
  return call[1]
}

// Separate worktrees: unkeyed notifications from one worktree collapse within the burst cooldown.
const OLDER_WORKTREE = 'repo-1::/repos/one'
const NEWER_WORKTREE = 'repo-1::/repos/two'
const OLDER_LEAF = '11111111-1111-4111-8111-111111111111'
const NEWER_LEAF = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
  vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
  vi.useFakeTimers()
  resetNotificationDispatchMocks()
})
afterEach(() => {
  // Drain entries a test left behind so the module-level list starts empty.
  while (openLatestNotification()) {
    // keep opening
  }
  vi.unstubAllEnvs()
})

type NotificationRuntime = NonNullable<Parameters<typeof registerNotificationHandlers>[1]>

function registerWithMainWindow(runtime?: Partial<NotificationRuntime>): ReturnType<typeof vi.fn> {
  const webContentsSend = vi.fn()
  getTrustedUIRendererWindowMock.mockReturnValue({
    isDestroyed: () => false,
    isFocused: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: webContentsSend }
  })
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only getSettings().notifications, which this stub provides.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: true
        }
      })
    } as never,
    runtime as never
  )
  return webContentsSend
}

async function dispatchFor(leafId: string, notificationId: string): Promise<void> {
  await getDispatchHandler()(
    {},
    {
      source: 'agent-task-complete',
      worktreeId: leafId === OLDER_LEAF ? OLDER_WORKTREE : NEWER_WORKTREE,
      paneKey: `tab-1:${leafId}`,
      notificationId
    }
  )
}

function focusedLeafIds(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.flatMap((call: unknown[]) => {
    const payload = call[1]
    return call[0] === 'ui:focusTerminal' &&
      typeof payload === 'object' &&
      payload !== null &&
      'leafId' in payload &&
      typeof payload.leafId === 'string'
      ? [payload.leafId]
      : []
  })
}

describe('open latest notification', () => {
  it('opens the newest notification like a click, then the older one', async () => {
    const send = registerWithMainWindow()
    await dispatchFor(OLDER_LEAF, 'older')
    await dispatchFor(NEWER_LEAF, 'newer')

    expect(openLatestNotification()).toBe(true)
    expect(send).toHaveBeenCalledWith('ui:activateWorktree', {
      repoId: 'repo-1',
      worktreeId: NEWER_WORKTREE
    })
    expect(send).toHaveBeenCalledWith('ui:focusTerminal', {
      tabId: 'tab-1',
      worktreeId: NEWER_WORKTREE,
      leafId: NEWER_LEAF,
      ackPaneKeyOnSuccess: `tab-1:${NEWER_LEAF}`,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    // Opening also removes the banner from the OS notification list, as a click does.
    expect(notificationCloseMock).toHaveBeenCalledTimes(1)

    expect(openLatestNotification()).toBe(true)
    expect(focusedLeafIds(send)).toEqual([NEWER_LEAF, OLDER_LEAF])
    expect(hasOpenableNotification()).toBe(false)
  })

  it('still opens a notification after its banner retention has expired', async () => {
    const send = registerWithMainWindow()
    await dispatchFor(NEWER_LEAF, 'waiting')

    // Orca releases the native banner after five minutes; the agent may still be waiting.
    vi.advanceTimersByTime(10 * 60 * 1000)

    expect(openLatestNotification()).toBe(true)
    expect(focusedLeafIds(send)).toEqual([NEWER_LEAF])
  })

  it('forgets a notification dismissed as read even after its retention expired', async () => {
    const send = registerWithMainWindow()
    await dispatchFor(OLDER_LEAF, 'older')
    await dispatchFor(NEWER_LEAF, 'newer')
    vi.advanceTimersByTime(10 * 60 * 1000)

    getDismissHandler()({}, ['newer'])

    expect(openLatestNotification()).toBe(true)
    expect(focusedLeafIds(send)).toEqual([OLDER_LEAF])
  })

  it('forgets a terminal bell once its pane is read, though bells carry no notification id', async () => {
    const send = registerWithMainWindow()
    await dispatchFor(OLDER_LEAF, 'older')
    await getDispatchHandler()(
      {},
      { source: 'terminal-bell', worktreeId: NEWER_WORKTREE, paneKey: `tab-1:${NEWER_LEAF}` }
    )
    vi.advanceTimersByTime(10 * 60 * 1000)

    // Reading a pane dismisses by pane key alone, as the renderer's attention removal does.
    getDismissHandler()({}, [], [`tab-1:${NEWER_LEAF}`])

    expect(openLatestNotification()).toBe(true)
    expect(focusedLeafIds(send)).toEqual([OLDER_LEAF])
    expect(openLatestNotification()).toBe(false)
  })

  it('forgets every notification of a read pane, even ids the announced registry already evicted', async () => {
    registerWithMainWindow()
    // More completions on one pane than the announced registry keeps ids for (20).
    for (let turn = 0; turn < 25; turn += 1) {
      await dispatchFor(NEWER_LEAF, `turn-${turn}`)
      vi.advanceTimersByTime(10_000)
    }

    getDismissHandler()({}, [], [`tab-1:${NEWER_LEAF}`])

    expect(hasOpenableNotification()).toBe(false)
  })

  it('forgets a replaced notification even when its replacement has no click target', async () => {
    registerWithMainWindow()
    await dispatchFor(NEWER_LEAF, 'replaced')
    // Step past the burst cooldown so the replacement is delivered.
    vi.advanceTimersByTime(10_000)

    await getDispatchHandler()({}, { source: 'agent-task-complete', notificationId: 'replaced' })

    expect(hasOpenableNotification()).toBe(false)
  })

  it('does not reopen a notification the user already clicked', async () => {
    const send = registerWithMainWindow()
    await dispatchFor(NEWER_LEAF, 'clicked')

    getNotificationEventHandler('click')()

    expect(focusedLeafIds(send)).toEqual([NEWER_LEAF])
    expect(openLatestNotification()).toBe(false)
  })

  it('no longer opens a notification that was dismissed as read', async () => {
    const send = registerWithMainWindow()
    await dispatchFor(OLDER_LEAF, 'older')
    await dispatchFor(NEWER_LEAF, 'newer')

    getDismissHandler()({}, ['newer'])

    expect(openLatestNotification()).toBe(true)
    expect(focusedLeafIds(send)).toEqual([OLDER_LEAF])
    expect(openLatestNotification()).toBe(false)
  })

  it('offers nothing to open for a notification without a click target', async () => {
    registerWithMainWindow()
    await getDispatchHandler()({}, { source: 'agent-task-complete', notificationId: 'no-target' })

    expect(hasOpenableNotification()).toBe(false)
  })
})

describe('open latest notification after attention is acknowledged elsewhere', () => {
  const newerWorktreeAcknowledged: NotificationAttentionAcknowledgement = {
    worktree: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: NEWER_WORKTREE,
      workspaceKind: 'git-worktree'
    },
    reads: []
  }

  it('forgets notifications acknowledged through the renderer', async () => {
    const send = registerWithMainWindow()
    await dispatchFor(OLDER_LEAF, 'older')
    await dispatchFor(NEWER_LEAF, 'newer')

    registeredHandler('notifications:acknowledgeAttention')({}, newerWorktreeAcknowledged)

    expect(openLatestNotification()).toBe(true)
    expect(focusedLeafIds(send)).toEqual([OLDER_LEAF])
    expect(openLatestNotification()).toBe(false)
  })

  it('forgets notifications acknowledged by another client of the runtime', async () => {
    let onClientEvent: Parameters<NotificationRuntime['onClientEvent']>[0] | undefined
    const send = registerWithMainWindow({
      onClientEvent: (listener) => {
        onClientEvent = listener
        return () => {}
      },
      dispatchMobileNotification: vi.fn(),
      dismissMobileNotification: vi.fn(),
      retireNotificationAttention: vi.fn()
    })
    await dispatchFor(OLDER_LEAF, 'older')
    await dispatchFor(NEWER_LEAF, 'newer')

    onClientEvent?.({
      type: 'notificationAttentionAcknowledged',
      acknowledgement: newerWorktreeAcknowledged
    })

    expect(openLatestNotification()).toBe(true)
    expect(focusedLeafIds(send)).toEqual([OLDER_LEAF])
    expect(openLatestNotification()).toBe(false)
  })

  it('forgets a notification read while its banner was still being shown', async () => {
    registerWithMainWindow()
    const scope = {
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: NEWER_WORKTREE,
      workspaceKind: 'git-worktree' as const
    }
    const origin: StructuredAttentionOrigin = {
      scope,
      sessionId: 'session-1',
      cause: { kind: 'completion', requestId: 'turn-1' },
      journalCursor: { epoch: 'journal', sequence: 1 }
    }
    const delivery = getDispatchHandler()(
      {},
      {
        source: 'agent-task-complete',
        worktreeId: NEWER_WORKTREE,
        paneKey: `tab-1:${NEWER_LEAF}`,
        notificationId: 'in-flight',
        structuredOrigin: origin,
        requireDisplayConfirmation: true
      }
    )
    await vi.waitFor(() => expect(hasOpenableNotification()).toBe(true))

    // Another pane reads the session; the in-flight banner's own pane is not dismissed.
    const otherPane = `tab-2:${OLDER_LEAF}`
    getDismissHandler()(
      {},
      [],
      [otherPane],
      [{ paneKey: otherPane, scope, sessionId: 'session-1', observedCursor: origin.journalCursor }]
    )
    expect(hasOpenableNotification()).toBe(true)

    getNotificationEventHandler('show', mocks.notificationOnce)()
    await delivery

    expect(hasOpenableNotification()).toBe(false)
  })
})
