import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StructuredAttentionOrigin } from '../../shared/agent-session/agent-session-attention'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import {
  getAllWindowsMock,
  notificationCtorMock,
  notificationShowMock,
  notificationCloseMock,
  readAuthorizationStatusMock,
  getDispatchHandler,
  getDismissHandler,
  handleMock,
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
import { activeNotificationsById } from './native-notification-lifecycle'
import { RuntimeMobileNotificationController } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import { RuntimeClientEventBus } from '../runtime/client/events/runtime-client-event-bus'

const nativePlatform = process.platform
const location = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder:agent',
  workspaceKind: 'folder'
} as const
let directory: string
let controller: RuntimeMobileNotificationController
let events: RuntimeClientEventBus
let dismissedMobile: string[]
let needsInput = true
let suppressFocused = false
let mutedSources: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  resetNotificationDispatchMocks()
  needsInput = true
  suppressFocused = false
  mutedSources = ['runtime:muted-host']
  directory = mkdtempSync(join(tmpdir(), 'orca-external-ack-'))
  controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  dismissedMobile = []
  controller.onDispatched((event) => {
    if (event.type === 'dismiss') {
      dismissedMobile.push(event.notificationId)
    }
  })
  events = new RuntimeClientEventBus({
    makeTitleGateKey: () => '',
    onConsumerAvailabilityChanged: () => {}
  })
  installHandlers()
})

function installHandlers(): void {
  handleMock.mockClear()
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: notification handlers read only these settings on this path.
    {
      getWorkspaceSession: () => ({ activeWorktreeId: location.workspaceId }),
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          agentNeedsInput: needsInput,
          terminalBell: true,
          suppressWhenFocused: suppressFocused,
          mutedNotificationSourceIds: mutedSources
        }
      })
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery and retirement use only the supplied runtime methods.
    {
      onClientEvent: events.on.bind(events),
      dispatchMobileNotification: controller.dispatch.bind(controller),
      dismissMobileNotification: controller.dismiss.bind(controller),
      reconcileStructuredPromptAttention:
        controller.reconcileStructuredPromptAttention.bind(controller),
      retireNotificationAttention: controller.acknowledgeAttention.bind(controller)
    } as never
  )
}
afterEach(async () => {
  for (const entry of activeNotificationsById.values()) {
    entry.release()
  }
  await controller.closeDismissals()
  rmSync(directory, { recursive: true, force: true })
  Object.defineProperty(process, 'platform', { value: nativePlatform, configurable: true })
  vi.useRealTimers()
})

const origin = (
  sequence: number,
  changes: Partial<StructuredAttentionOrigin['scope']> = {}
): StructuredAttentionOrigin => ({
  scope: { ...location, ...changes },
  sessionId: 'session',
  cause: { kind: 'completion', requestId: `turn-${sequence}` },
  journalCursor: { epoch: 'journal', sequence }
})
const dispatch = (id: string, request: Partial<NotificationDispatchRequest> = {}) =>
  getDispatchHandler()(
    {},
    {
      source: 'agent-task-complete',
      notificationId: id,
      attentionKey: id,
      worktreeId: location.workspaceId,
      paneKey: `pane:${id}`,
      ...request
    }
  )

it('settles qualified remote prompt copies through their stored origin without clearing another transport', async () => {
  const prompt = { ...origin(3), cause: { kind: 'prompt' as const, promptId: 'permission' } }
  await dispatch('same-prompt', { structuredOrigin: prompt })
  await dispatch('same-prompt', { executionHost: 'runtime:remote', structuredOrigin: prompt })
  const handler: unknown = handleMock.mock.calls.find(
    ([channel]) => channel === 'notifications:settleStructuredPrompts'
  )?.[1]
  if (typeof handler !== 'function') {
    throw new Error('settlement IPC not installed')
  }
  handler({}, location, 'session', 'runtime:remote')
  expect(dismissedMobile).toEqual(['["runtime:remote","same-prompt"]'])
})

it('retires a persisted pane read after restart without a new host event, preserving other owners and newer news', async () => {
  await dispatch('covered', {
    paneKey: 'read-pane',
    executionHost: 'runtime:remote',
    structuredOrigin: origin(3)
  })
  await dispatch('newer', {
    paneKey: 'read-pane',
    executionHost: 'runtime:remote',
    structuredOrigin: origin(6)
  })
  await dispatch('other-pane', {
    paneKey: 'other-pane',
    executionHost: 'runtime:remote',
    structuredOrigin: origin(3, { wslDistro: 'Ubuntu' })
  })
  await dispatch('local-copy', { paneKey: 'read-pane', structuredOrigin: origin(3) })
  await controller.closeDismissals()
  for (const entry of activeNotificationsById.values()) {
    entry.release()
  }
  controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  const retired: unknown[] = []
  controller.onDispatched((event) => {
    if (event.type === 'dismiss') {
      retired.push(event)
    }
  })
  installHandlers()

  getDismissHandler()(
    {},
    [],
    ['read-pane'],
    [
      {
        paneKey: 'read-pane',
        sessionId: 'session',
        observedCursor: { epoch: 'journal', sequence: 5 },
        executionHost: 'runtime:remote'
      }
    ]
  )

  expect(retired).toEqual([
    expect.objectContaining({
      notificationId: '["runtime:remote","covered"]',
      dismissedDelivery: expect.objectContaining({ notificationSeq: 1 })
    })
  ])
  expect(
    await dispatch('delayed', {
      paneKey: 'read-pane',
      executionHost: 'runtime:remote',
      structuredOrigin: origin(4)
    })
  ).toEqual({ delivered: false, reason: 'already-read' })
})

it('uses agent input policy and focused-workspace suppression for retained host attention', async () => {
  const notice = {
    notificationId: 'orchestration-mail:terminal',
    title: 'Claude in Review may have missed mail',
    body: 'Ask Claude to run orca orchestration check --run run_review.',
    worktreeId: location.workspaceId,
    paneKey: 'review-pane'
  }
  const publish = () =>
    events.emit({
      type: 'agentAttentionChanged',
      notificationId: notice.notificationId,
      notice
    })
  needsInput = false
  publish()
  await vi.advanceTimersByTimeAsync(0)
  expect(notificationShowMock).not.toHaveBeenCalled()
  needsInput = true
  mutedSources = ['local']
  events.emit({
    type: 'agentAttentionChanged',
    notificationId: notice.notificationId,
    notice: null
  })
  publish()
  await vi.advanceTimersByTimeAsync(0)
  expect(notificationShowMock).not.toHaveBeenCalled()
  mutedSources = []
  suppressFocused = true
  getAllWindowsMock.mockReturnValue([
    { isDestroyed: () => false, isFocused: () => true, isVisible: () => true }
  ])
  events.emit({
    type: 'agentAttentionChanged',
    notificationId: notice.notificationId,
    notice: null
  })
  publish()
  await vi.advanceTimersByTimeAsync(0)
  expect(notificationShowMock).not.toHaveBeenCalled()
  suppressFocused = false
  readAuthorizationStatusMock.mockResolvedValue('authorized')
  events.emit({
    type: 'agentAttentionChanged',
    notificationId: notice.notificationId,
    notice: null
  })
  publish()
  await vi.advanceTimersByTimeAsync(0)
  expect(notificationShowMock).toHaveBeenCalledOnce()
  expect(notificationCtorMock).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Claude in Review may have missed mail',
      body: 'Ask Claude to run orca orchestration check --run run_review.'
    })
  )
  publish()
  await vi.advanceTimersByTimeAsync(0)
  expect(notificationShowMock).toHaveBeenCalledOnce()
  const replacement = {
    ...notice,
    body: 'Ask Claude to run orca orchestration check --run run_review.\nAsk Claude to run orca orchestration check --run run_added.'
  }
  events.emit({
    type: 'agentAttentionChanged',
    notificationId: notice.notificationId,
    notice: replacement
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(notificationShowMock).toHaveBeenCalledTimes(2)
  expect(notificationCtorMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      body: 'Ask Claude to run orca orchestration check --run run_review.\nAsk Claude to run orca orchestration check --run run_added.'
    })
  )
  events.emit({
    type: 'agentAttentionChanged',
    notificationId: notice.notificationId,
    notice: null
  })
  expect(notificationCloseMock).toHaveBeenCalledTimes(2)
})
