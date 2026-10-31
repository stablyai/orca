import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getDismissHandler,
  getDispatchHandler,
  getNotificationEventHandler,
  getTrustedUIRendererWindowMock,
  notificationCloseMock,
  resetNotificationDispatchMocks
} from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { registerNotificationHandlers } from './notifications'
import { hasOpenableNotification, openLatestNotification } from './openable-notifications'

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

function registerWithMainWindow(): ReturnType<typeof vi.fn> {
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only getSettings().notifications, which this stub provides.
  registerNotificationHandlers({
    getSettings: () => ({
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: true
      }
    })
  } as never)
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
