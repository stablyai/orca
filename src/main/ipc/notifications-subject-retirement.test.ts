import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllWindowsMock,
  getDismissHandler,
  getDispatchHandler,
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

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function register(options: { suppressWhenFocused: boolean }): {
  dispatchMobileNotification: ReturnType<typeof vi.fn>
  dismissMobileNotification: ReturnType<typeof vi.fn>
} {
  const dispatchMobileNotification = vi.fn()
  const dismissMobileNotification = vi.fn()
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getSettings; Store is a class, so a structural double needs the cast.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: options.suppressWhenFocused
        }
      })
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch and dismiss call only these two runtime methods.
    { dispatchMobileNotification, dismissMobileNotification } as never
  )
  return { dispatchMobileNotification, dismissMobileNotification }
}

describe('notifications:dismiss by acknowledged subject', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
  })

  it('retires a shown banner by its subject alone, then forgets the subject', async () => {
    const { dismissMobileNotification } = register({ suppressWhenFocused: false })
    expect(
      await getDispatchHandler()(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          paneKey: PANE,
          notificationId: 'agent:minted'
        }
      )
    ).toEqual({ delivered: true })

    // The renderer's rebuilt id no longer matches (the row's start moved); the subject still does.
    expect(getDismissHandler()({}, ['agent:rebuilt'], [PANE])).toEqual({ dismissed: 1 })
    expect(notificationCloseMock).toHaveBeenCalledTimes(1)
    expect(dismissMobileNotification.mock.calls.map(([id]) => id).sort()).toEqual([
      'agent:minted',
      'agent:rebuilt'
    ])

    dismissMobileNotification.mockClear()
    expect(getDismissHandler()({}, [], [PANE])).toEqual({ dismissed: 0 })
    expect(dismissMobileNotification).not.toHaveBeenCalled()
  })

  it('retires a phone alert whose desktop banner focus suppressed', async () => {
    const focusedWindow = { isDestroyed: () => false, isFocused: () => true }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the focus gate reads only these two window methods.
    getAllWindowsMock.mockReturnValue([focusedWindow] as never)
    const { dispatchMobileNotification, dismissMobileNotification } = register({
      suppressWhenFocused: true
    })
    expect(
      await getDispatchHandler()(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          paneKey: PANE,
          notificationId: 'agent:phone-only',
          isActiveWorktree: true
        }
      )
    ).toEqual({ delivered: false, reason: 'suppressed-focus' })
    expect(dispatchMobileNotification).toHaveBeenCalledOnce()

    getDismissHandler()({}, [], [PANE])
    expect(dismissMobileNotification).toHaveBeenCalledWith('agent:phone-only')
  })

  it('records nothing for a request neither the desktop nor the phone announced', async () => {
    const { dismissMobileNotification } = register({ suppressWhenFocused: false })
    const dispatch = getDispatchHandler()
    await dispatch(
      {},
      {
        source: 'agent-task-complete',
        worktreeId: 'repo::wt1',
        paneKey: 'tab-0:first',
        notificationId: 'agent:first'
      }
    )
    // Inside the first one's per-workspace cooldown: turned away on both paths.
    expect(
      await dispatch(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          paneKey: PANE,
          notificationId: 'agent:quiet'
        }
      )
    ).toEqual({ delivered: false, reason: 'cooldown' })

    getDismissHandler()({}, [], [PANE])
    expect(dismissMobileNotification).not.toHaveBeenCalled()
  })
})
