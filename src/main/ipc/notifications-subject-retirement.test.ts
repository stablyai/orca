import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../runtime/runtime-mobile-notification-controller'
import {
  agentSessionAttentionSubjectPrefix,
  type StructuredAttentionOrigin
} from '../../shared/agent-session-attention'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllWindowsMock,
  getDismissHandler,
  getDispatchHandler,
  getSettleStructuredPromptsHandler,
  notificationCloseMock,
  resetNotificationDispatchMocks,
  notificationIsSupportedMock
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

import { registerSubjectRetirement as register } from './notifications-subject-retirement.test-fixture'
import { AgentHookServer } from '../agent-hooks/server'
import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import { TerminalAgentPhonePush } from '../runtime/terminal-agent-phone-push'
import { createAgentHookNotificationRetirement } from '../../renderer/src/hooks/agent-hook-notification-retirement'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

describe('notifications:dismiss by acknowledged subject', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
  })

  it('reads the exact headless background alert after window return, and retires only a proved new start', () => {
    const server = new AgentHookServer()
    const detector = new AgentTransitionDetector({
      resolveTabWorktreeId: () => 'wt-1',
      subscribeToPtyExit: () => () => {},
      now: Date.now
    })
    const controller = new RuntimeMobileNotificationController()
    const events: MobileNotificationEvent[] = []
    controller.onDispatched((event) => events.push(event))
    let hasWindow = false
    const push = new TerminalAgentPhonePush({
      hasWindow: () => hasWindow,
      readNotificationSettings: () => undefined,
      readWorkspaceLabels: () => ({}),
      isWorkspaceMuted: () => false,
      readHookRow: (key) => detector.latestRow(key),
      dispatch: (event) => controller.dispatch(event),
      retire: (alerts) => controller.retireLiveNotifications(alerts),
      recordAnnounced: (key, id) => controller.announcedNotifications.record(key, id),
      now: Date.now
    })
    detector.subscribe((change) => push.observe(change))
    const detach = detector.attach(server)
    const report = (state: 'working' | 'done' | 'waiting', turnCompletedAt?: number) =>
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: {
          state,
          prompt: '',
          agentType: 'claude',
          ...(turnCompletedAt ? { turnCompletedAt } : {})
        }
      })
    try {
      vi.setSystemTime(100_100)
      report('working')
      vi.setSystemTime(100_200)
      report('working', 100_200)
      const emitted = events[0]
      expect(emitted).toMatchObject({
        type: 'notification',
        notificationId: expect.stringMatching(/:100200$/)
      })
      expect(server.getStatusSnapshot()[0]?.stateStartedAt).toBe(100_100)
      hasWindow = true
      register({ suppressWhenFocused: false }, controller)
      notificationIsSupportedMock.mockReturnValue(false)
      getDismissHandler()({}, ['agent:wrong:100'], [PANE])
      expect(events.slice(1)).toEqual([
        expect.objectContaining({ type: 'dismiss', notificationId: 'agent:wrong:100' }),
        expect.objectContaining({ type: 'dismiss', notificationId: emitted?.notificationId })
      ])
      hasWindow = false
      vi.setSystemTime(230_000)
      report('done')
      vi.advanceTimersByTime(1_500)
      expect(events.filter((event) => event.type === 'notification')).toHaveLength(1)
      vi.setSystemTime(240_000)
      report('working')
      report('waiting')
      const beforeStart = events.filter((event) => event.type === 'dismiss').length
      vi.setSystemTime(250_000)
      report('working')
      expect(events.filter((event) => event.type === 'dismiss')).toHaveLength(beforeStart)
      // Positive source IDs exercise the conditional contract; ordinary projection above omits them.
      const retirementSource = { runId: 'fixture-run', executionId: 'fixture-execution' }
      let start = 160_000
      const proved = (state: 'working' | 'waiting', at: number, replay = false) => {
        return {
          state,
          prompt: '',
          agentType: 'claude',
          stateStartedAt: at,
          turnStartedAt: start,
          ...retirementSource,
          ...(replay ? { isReplay: true } : {})
        }
      }
      const retirement = createAgentHookNotificationRetirement(
        () => 'pty-1',
        (alerts) => controller.retireLiveNotifications(alerts)
      )
      retirement.observe(proved('working', 160_000))
      controller.dispatch({
        type: 'notification',
        source: 'agent-task-complete',
        title: '',
        body: '',
        notificationId: 'conditional'
      })
      retirement.record({ notificationId: 'conditional' }, proved('waiting', 170_000))
      retirement.observe(proved('working', 180_000))
      expect(events.at(-1)?.type).toBe('notification')
      start = 190_000
      retirement.observe(proved('working', 190_000))
      expect(events.at(-1)).toMatchObject({
        type: 'dismiss',
        notificationId: 'conditional',
        dismissedDelivery: { notificationId: 'conditional' }
      })
      controller.dispatch({
        type: 'notification',
        source: 'agent-task-complete',
        title: '',
        body: '',
        notificationId: 'replay'
      })
      retirement.record({ notificationId: 'replay' }, proved('waiting', 200_000))
      start = 210_000
      retirement.observe(proved('working', 210_000, true))
      expect(events.at(-1)?.type).toBe('notification')
    } finally {
      detach()
      push.dispose()
    }
  })

  it('withdraws only the exact forwarded delivery through the existing dismiss bridge', () => {
    const controller = new RuntimeMobileNotificationController()
    const events: MobileNotificationEvent[] = []
    controller.onDispatched((event) => events.push(event))
    register({ suppressWhenFocused: false }, controller)
    controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: '',
      notificationId: 'forwarded',
      executionHost: 'runtime:host-b'
    })
    getDismissHandler()({}, [], [], undefined, [{ notificationId: 'forwarded' }])
    expect(events).toHaveLength(1)
    getDismissHandler()({}, [], [], undefined, [
      { notificationId: 'forwarded', executionHost: 'runtime:host-b' }
    ])
    expect(events[1]).toMatchObject({
      type: 'dismiss',
      dismissedDelivery: {
        notificationId: 'forwarded',
        notificationEpoch: events[0]?.notificationEpoch,
        notificationSeq: 1
      }
    })
    getDismissHandler()({}, [], [], undefined, [
      { notificationId: 'forwarded', executionHost: 'runtime:host-b' }
    ])
    expect(events).toHaveLength(2)
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

    // Rebuilt row IDs can change with start position; subject identity stays stable.
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
  // Positioned alerts survive reads before their journal boundary; pane-wide views cannot retire them.
  it('pane dismissal retires older-host structured alerts but not positioned ones past the read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pane-boundary-'))
    const controller = new RuntimeMobileNotificationController()
    try {
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
      // Older hosts lack journal positions on completions.
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
      await controller.closeDismissals()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('the click-time read a Mark read sends closes and retires every alert it covers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-explicit-read-'))
    const controller = new RuntimeMobileNotificationController()
    try {
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
      await controller.closeDismissals()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('settles only the relayed prompt alerts of a session its host reports none pending for', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-relay-settle-'))
    const controller = new RuntimeMobileNotificationController()
    try {
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
      await controller.closeDismissals()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
