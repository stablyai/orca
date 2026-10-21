import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAttentionOrigin } from '../../shared/agent-session-attention'

import {
  getDismissHandler,
  getDispatchHandler,
  notificationCtorMock,
  notificationRemoveGroupMock,
  notificationRemoveMock,
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

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const originalPlatform = process.platform

const STRUCTURED_ORIGIN: StructuredAttentionOrigin = {
  scope: {
    executionHostId: 'runtime:remote-host',
    wslDistro: null,
    workspaceId: 'remote-folder',
    workspaceKind: 'folder'
  },
  sessionId: 'remote-session',
  cause: { kind: 'prompt', promptId: 'A' },
  journalCursor: { epoch: 'remote-journal', sequence: 1 }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function register(): void {
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getSettings; Store is a class, so a structural double needs the cast.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false
        }
      })
    } as never
  )
}

function dispatchStructured(): unknown {
  return getDispatchHandler()(
    {},
    {
      source: 'agent-task-complete',
      surface: 'agent-session',
      worktreeId: 'repo::remote',
      paneKey: PANE,
      notificationId: 'agent-attention:A',
      attentionKey: 'agent-attention:A',
      structuredOrigin: STRUCTURED_ORIGIN
    }
  )
}

function lastNotificationOptions(): unknown {
  return notificationCtorMock.mock.lastCall?.[0]
}

describe('macOS Notification Center removal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
    setPlatform('darwin')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.useRealTimers()
  })

  it.each([
    { source: 'agent-task-complete', notificationId: 'agent:turn-1' },
    { source: 'terminal-bell' }
  ])('posts a $source notification in its pane thread with no id', async (request) => {
    register()
    await getDispatchHandler()({}, { ...request, worktreeId: 'repo::wt1', paneKey: PANE })

    expect(notificationCtorMock).toHaveBeenCalledOnce()
    expect(lastNotificationOptions()).toMatchObject({ groupId: `pane:${PANE}` })
    expect(lastNotificationOptions()).not.toHaveProperty('id')
  })

  it('posts a notification with no pane outside any thread', async () => {
    register()
    await getDispatchHandler()({}, { source: 'test' })

    expect(notificationCtorMock).toHaveBeenCalledOnce()
    expect(lastNotificationOptions()).not.toHaveProperty('id')
    expect(lastNotificationOptions()).not.toHaveProperty('groupId')
  })

  it('removes a read pane’s thread with no notification held, as after a restart', () => {
    register()

    getDismissHandler()({}, ['agent:rebuilt'], [PANE])

    expect(notificationRemoveGroupMock).toHaveBeenCalledExactlyOnceWith(`pane:${PANE}`)
    expect(notificationRemoveMock).not.toHaveBeenCalled()
  })

  it('removes a structured alert by id only once a read covers it', async () => {
    register()
    await dispatchStructured()
    expect(lastNotificationOptions()).toMatchObject({ id: 'agent-attention:A' })
    expect(lastNotificationOptions()).not.toHaveProperty('groupId')

    getDismissHandler()({}, [], [PANE])
    expect(notificationRemoveMock).not.toHaveBeenCalled()

    getDismissHandler()(
      {},
      [],
      [PANE],
      [
        {
          paneKey: PANE,
          sessionId: 'remote-session',
          observedCursor: { epoch: 'remote-journal', sequence: 1 }
        }
      ]
    )
    expect(notificationRemoveMock).toHaveBeenCalledExactlyOnceWith(['agent-attention:A'])
  })

  it.each(['win32', 'linux'] as const)('leaves %s on the close() path', async (platform) => {
    setPlatform(platform)
    register()
    await getDispatchHandler()(
      {},
      {
        source: 'agent-task-complete',
        worktreeId: 'repo::wt1',
        paneKey: PANE,
        notificationId: 'agent:turn-1'
      }
    )

    expect(notificationCtorMock).toHaveBeenCalledOnce()
    expect(lastNotificationOptions()).not.toHaveProperty('id')
    expect(lastNotificationOptions()).not.toHaveProperty('groupId')

    getDismissHandler()({}, ['agent:turn-1'], [PANE])
    expect(notificationRemoveMock).not.toHaveBeenCalled()
    expect(notificationRemoveGroupMock).not.toHaveBeenCalled()
  })
})
