import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const OTHER_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'
const FIVE_MINUTES_MS = 5 * 60 * 1000

const originalPlatform = process.platform

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
          suppressWhenFocused: false,
          mutedNotificationSourceIds: []
        }
      })
    } as never
  )
}

function expectLastNotificationOptions(expected: Record<string, unknown>): void {
  expect(notificationCtorMock).toHaveBeenLastCalledWith(expect.objectContaining(expected))
}

function expectLastNotificationOptionsWithout(key: string): void {
  expect(notificationCtorMock).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ [key]: expect.anything() })
  )
}

describe('macOS Notification Center removal (#26732)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
    setPlatform('darwin')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('gives an agent notification its id and a per-pane group on macOS', async () => {
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

    expectLastNotificationOptions({ id: 'agent:turn-1', groupId: `pane:${PANE}` })
  })

  it('gives a terminal bell a stable pane-scoped id so a repeat replaces it', async () => {
    register()
    const dispatch = getDispatchHandler()
    await dispatch({}, { source: 'terminal-bell', worktreeId: 'repo::wt1', paneKey: PANE })
    expectLastNotificationOptions({ id: `terminal-bell:${PANE}`, groupId: `pane:${PANE}` })
    // Past the per-workspace burst cooldown.
    vi.advanceTimersByTime(60_000)
    await dispatch({}, { source: 'terminal-bell', worktreeId: 'repo::wt1', paneKey: PANE })

    expect(notificationCtorMock).toHaveBeenCalledTimes(2)
    expectLastNotificationOptions({ id: `terminal-bell:${PANE}` })
  })

  it('removes a delivered notification by id and pane group after the in-memory release', async () => {
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
    // The live Notification object is released after five minutes; close() can no longer reach it.
    vi.advanceTimersByTime(FIVE_MINUTES_MS + 1)

    getDismissHandler()({}, ['agent:turn-1'], [PANE])

    expect(notificationRemoveMock).toHaveBeenCalledWith(['agent:turn-1'])
    expect(notificationRemoveGroupMock).toHaveBeenCalledWith(`pane:${PANE}`)
    expect(notificationRemoveGroupMock).not.toHaveBeenCalledWith(`pane:${OTHER_PANE}`)
  })

  it('removes a previous session’s notifications for an acknowledged pane after a restart', () => {
    // Nothing was dispatched in this process: the record main keeps in memory is empty.
    register()

    getDismissHandler()({}, ['agent:rebuilt'], [PANE])

    expect(notificationRemoveMock).toHaveBeenCalledWith(['agent:rebuilt'])
    expect(notificationRemoveGroupMock).toHaveBeenCalledWith(`pane:${PANE}`)
  })

  it('keeps a positioned structured alert out of the pane group a plain pane read clears', async () => {
    register()
    await getDispatchHandler()(
      {},
      {
        source: 'agent-task-complete',
        worktreeId: 'repo::wt1',
        paneKey: PANE,
        notificationId: 'agent-attention:A',
        structuredOrigin: {
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
      }
    )

    expectLastNotificationOptions({ id: 'agent-attention:A' })
    expectLastNotificationOptionsWithout('groupId')

    getDismissHandler()({}, [], [PANE])
    expect(notificationRemoveMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['agent-attention:A'])
    )
  })

  it('leaves other platforms on the existing close() path', async () => {
    setPlatform('linux')
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

    expectLastNotificationOptionsWithout('id')
    expectLastNotificationOptionsWithout('groupId')

    getDismissHandler()({}, ['agent:turn-1'], [PANE])
    expect(notificationRemoveMock).not.toHaveBeenCalled()
    expect(notificationRemoveGroupMock).not.toHaveBeenCalled()
  })
})
