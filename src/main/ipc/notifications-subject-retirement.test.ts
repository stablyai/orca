import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationDispatchEvent,
  type MobileNotificationEvent
} from '../runtime/runtime-mobile-notification-controller'
import {
  agentSessionAttentionSubjectPrefix,
  type StructuredAttentionRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionState
} from '../../shared/agent-session-attention'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllWindowsMock,
  getDismissHandler,
  getDispatchHandler,
  getSettleStructuredPromptsHandler,
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

function register(
  options: { suppressWhenFocused: boolean },
  controller?: RuntimeMobileNotificationController
): {
  dispatchMobileNotification: ReturnType<typeof vi.fn>
  dismissMobileNotification: ReturnType<typeof vi.fn>
} {
  const dispatchMobileNotification = vi.fn((event: MobileNotificationDispatchEvent) =>
    controller?.dispatch(event)
  )
  const dismissMobileNotification = vi.fn((id: string) => controller?.dismiss(id))
  const retireStructuredAttention = (read: StructuredAttentionRead) =>
    controller?.retireStructuredAttention(read)
  const reconcileStructuredPromptAttention = (state: StructuredAttentionState) =>
    controller?.reconcileStructuredPromptAttention(state)
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notification handlers call only these four runtime methods.
    {
      dispatchMobileNotification,
      dismissMobileNotification,
      retireStructuredAttention,
      reconcileStructuredPromptAttention
    } as never
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
  // Positioned alerts outlive a no-read or earlier-bounded dismiss: a view ack can run before the transcript shows the edge.
  it('pane dismissal retires older-host structured alerts but not positioned ones past the read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pane-boundary-'))
    try {
      const controller = new RuntimeMobileNotificationController()
      controller.configureDismissalStore(directory)
      const events: MobileNotificationEvent[] = []
      controller.onDispatched((event) => events.push(event))
      const { dismissMobileNotification } = register({ suppressWhenFocused: false }, controller)
      const origin = (id: string, sequence: number): StructuredAttentionOrigin => ({
        scope: {
          executionHostId: 'runtime:remote-host',
          wslDistro: null,
          workspaceId: 'remote-folder',
          workspaceKind: 'folder'
        },
        sessionId: 'remote-session',
        cause: { kind: 'prompt', promptId: id },
        journalCursor: { epoch: 'remote-journal', sequence }
      })
      const dispatch = getDispatchHandler()
      // A host older than journal cursors sends its completion with no position.
      for (const [id, cause] of [
        ['agent-attention:older-host', undefined],
        ['agent-attention:A', origin('A', 1)],
        ['agent-attention:B', origin('B', 2)]
      ] as const) {
        await dispatch(
          {},
          {
            source: 'agent-task-complete',
            surface: 'agent-session',
            paneKey: PANE,
            notificationId: id,
            attentionKey: id,
            structuredOrigin: cause,
            worktreeId: 'repo::remote'
          }
        )
      }
      expect(events.filter((event) => event.type === 'notification')).toHaveLength(3)
      getDismissHandler()({}, ['agent-attention:B'], [PANE])
      getDismissHandler()({}, [], [PANE], [{ paneKey: PANE, sessionId: 'remote-session' }])
      expect(notificationCloseMock).toHaveBeenCalledTimes(1)
      expect(dismissMobileNotification.mock.calls).toEqual([['agent-attention:older-host']])
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
      expect(
        events.filter((event) => event.type === 'dismiss').map((event) => event.notificationId)
      ).toEqual(['agent-attention:older-host', 'agent-attention:A'])
      getDismissHandler()({}, ['agent-attention:B'], [PANE])
      expect(dismissMobileNotification).toHaveBeenCalledTimes(1)
      expect(events.filter((event) => event.type === 'dismiss')).toHaveLength(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('the click-time read a Mark read sends closes and retires every alert it covers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-explicit-read-'))
    try {
      const controller = new RuntimeMobileNotificationController()
      controller.configureDismissalStore(directory)
      const events: MobileNotificationEvent[] = []
      controller.onDispatched((event) => events.push(event))
      register({ suppressWhenFocused: false }, controller)
      const scope = {
        executionHostId: 'runtime:remote-host',
        wslDistro: null,
        workspaceId: 'remote-folder',
        workspaceKind: 'folder'
      } as const
      for (const [id, sequence] of [
        ['A', 1],
        ['B', 2]
      ] as const) {
        await getDispatchHandler()(
          {},
          {
            source: 'agent-task-complete',
            surface: 'agent-session',
            paneKey: PANE,
            notificationId: `agent-attention:click-${id}`,
            attentionKey: `agent-attention:click-${id}`,
            structuredOrigin: {
              scope,
              sessionId: 'remote-session',
              cause: { kind: 'prompt', promptId: id },
              journalCursor: { epoch: 'remote-journal', sequence }
            },
            worktreeId: 'repo::remote'
          }
        )
      }
      getDismissHandler()(
        {},
        [],
        [PANE],
        [
          {
            paneKey: PANE,
            sessionId: 'remote-session',
            observedCursor: { epoch: 'remote-journal', sequence: 2 }
          }
        ]
      )
      expect(notificationCloseMock).toHaveBeenCalledTimes(2)
      expect(
        events.filter((event) => event.type === 'dismiss').map((event) => event.notificationId)
      ).toEqual(['agent-attention:click-A', 'agent-attention:click-B'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('settles only the relayed prompt alerts of a session its host reports none pending for', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-relay-settle-'))
    try {
      const controller = new RuntimeMobileNotificationController()
      controller.configureDismissalStore(directory)
      const events: MobileNotificationEvent[] = []
      controller.onDispatched((event) => events.push(event))
      register({ suppressWhenFocused: false }, controller)
      const scope = {
        executionHostId: 'runtime:remote-host',
        wslDistro: null,
        workspaceId: 'remote-folder',
        workspaceKind: 'folder'
      } as const
      const key = (suffix: string) =>
        `${agentSessionAttentionSubjectPrefix(scope, 'remote-session')}${suffix}`
      for (const cause of [
        { kind: 'prompt', promptId: 'A' },
        { kind: 'completion', requestId: 'turn-1' }
      ] as const) {
        const id = key(cause.kind === 'prompt' ? 'prompt:A' : 'turn:turn-1')
        await getDispatchHandler()(
          {},
          {
            source: 'agent-task-complete',
            surface: 'agent-session',
            paneKey: PANE,
            notificationId: id,
            attentionKey: id,
            structuredOrigin: {
              scope,
              sessionId: 'remote-session',
              cause,
              journalCursor: { epoch: 'remote-journal', sequence: 1 }
            },
            worktreeId: 'repo::remote'
          }
        )
      }
      const settle = getSettleStructuredPromptsHandler()
      settle({}, { executionHostId: 7 }, 'remote-session')
      settle({}, scope, '')
      expect(events.filter((event) => event.type === 'dismiss')).toEqual([])
      settle({}, scope, 'remote-session')
      expect(
        events.filter((event) => event.type === 'dismiss').map((event) => event.notificationId)
      ).toEqual([key('prompt:A')])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
