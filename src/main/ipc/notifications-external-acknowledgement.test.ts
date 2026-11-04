import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StructuredAttentionOrigin } from '../../shared/agent-session/agent-session-attention'
import type {
  NotificationAttentionAcknowledgement,
  NotificationDispatchRequest
} from '../../shared/notification-settings-types'
import {
  getDispatchHandler,
  getDismissHandler,
  readAuthorizationStatusMock,
  notificationRemoveGroupMock,
  handleMock,
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
import { activeNotificationsById } from './native-notification-lifecycle'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import { RuntimeClientEventBus } from '../runtime/runtime-client-event-bus'

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

beforeEach(() => {
  vi.useFakeTimers()
  resetNotificationDispatchMocks()
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
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          agentNeedsInput: true,
          terminalBell: true,
          suppressWhenFocused: false,
          mutedNotificationSourceIds: ['runtime:muted-host']
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
const publish = (accepted: NotificationAttentionAcknowledgement): void => {
  controller.acknowledgeAttention(accepted)
  events.emit({ type: 'notificationAttentionAcknowledged', acknowledgement: accepted })
}
const acknowledgement = (): NotificationAttentionAcknowledgement => ({
  worktree: location,
  reads: [
    { scope: location, sessionId: 'session', observedCursor: { epoch: 'journal', sequence: 5 } }
  ]
})

it.each(['linux', 'darwin', 'win32'] as const)(
  'retires explicit workspace reads through the existing %s desktop owner, including pane-less alerts',
  async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    installHandlers()
    await dispatch('read', { paneKey: undefined })
    await dispatch('other-workspace', { worktreeId: 'folder:other' })
    await dispatch('other-host', { executionHost: 'runtime:remote' })
    await vi.advanceTimersByTimeAsync(6 * 60_000)

    publish(acknowledgement())

    expect(activeNotificationsById.has('read')).toBe(false)
    if (platform !== 'darwin') {
      expect(activeNotificationsById.has('other-workspace')).toBe(true)
      expect(activeNotificationsById.has('["runtime:remote","other-host"]')).toBe(true)
    } else {
      expect(notificationRemoveMock).toHaveBeenCalledWith(['read'])
    }
    expect(dismissedMobile).toEqual(['read'])
  }
)

it('preserves newer cursors, sessions and copied host/WSL identities, then suppresses delayed covered delivery', async () => {
  for (const [id, structuredOrigin] of [
    ['read', origin(3)],
    ['newer', origin(6)],
    ['other-session', { ...origin(3), sessionId: 'another-session' }],
    ['wsl', origin(3, { wslDistro: 'Ubuntu' })],
    ['ssh', origin(3, { executionHostId: 'ssh:other' })]
  ] as const) {
    await dispatch(id, { structuredOrigin })
  }

  publish(acknowledgement())

  expect([...activeNotificationsById.keys()].sort()).toEqual([
    'newer',
    'other-session',
    'ssh',
    'wsl'
  ])
  expect(dismissedMobile).toEqual(['read'])
  expect(await dispatch('delayed', { structuredOrigin: origin(4) })).toEqual({
    delivered: false,
    reason: 'already-read'
  })
  expect(activeNotificationsById.has('delayed')).toBe(false)
  expect(controller.getMissedSince(0).some((event) => event.notificationId === 'delayed')).toBe(
    false
  )
})

it('qualifies remote acknowledgement by its transport without rebinding the producer scope', async () => {
  await dispatch('remote-read', { executionHost: 'runtime:remote', structuredOrigin: origin(3) })
  await dispatch('local-copy', { structuredOrigin: origin(3) })
  await dispatch('other-runtime', { executionHost: 'runtime:other', structuredOrigin: origin(3) })
  const handler: unknown = handleMock.mock.calls.find(
    ([channel]) => channel === 'notifications:acknowledgeAttention'
  )?.[1]
  if (typeof handler !== 'function') {
    throw new Error('acknowledgement IPC not installed')
  }
  handler({}, acknowledgement(), 'runtime:remote')

  expect([...activeNotificationsById.keys()].sort()).toEqual([
    '["runtime:other","other-runtime"]',
    'local-copy'
  ])
  expect(dismissedMobile).toEqual(['["runtime:remote","remote-read"]'])
  expect(
    await dispatch('remote-delayed', {
      executionHost: 'runtime:remote',
      structuredOrigin: origin(4)
    })
  ).toEqual({ delivered: false, reason: 'already-read' })
  expect(await dispatch('local-new', { structuredOrigin: origin(4) })).toEqual({ delivered: true })
})

it('keeps legacy workspace alerts on a session-specific acknowledgement', async () => {
  await dispatch('legacy')
  await dispatch('session-read', { structuredOrigin: origin(3) })
  publish({ reads: acknowledgement().reads })
  expect([...activeNotificationsById.keys()]).toEqual(['legacy'])
  expect(dismissedMobile).toEqual(['session-read'])
})

it.each([
  { executionHost: undefined, localExecutionHostId: 'local' },
  { executionHost: 'runtime:remote', localExecutionHostId: 'local' },
  { executionHost: 'runtime:remote', localExecutionHostId: 'runtime:remote' }
] as const)(
  'keeps physical host identity through $executionHost with local alias $localExecutionHostId',
  async ({ executionHost, localExecutionHostId }) => {
    await dispatch('ssh-read', { executionHost, workspaceExecutionHostId: 'ssh:host-a' })
    await dispatch('local-copy', {
      executionHost,
      workspaceExecutionHostId: executionHost ?? 'local'
    })
    await dispatch('host-local-copy', { executionHost })
    await dispatch('unknown-physical', { executionHost, workspaceExecutionHostId: null })
    await dispatch('other-ssh', { executionHost, workspaceExecutionHostId: 'ssh:host-b' })
    const handler: unknown = handleMock.mock.calls.find(
      ([channel]) => channel === 'notifications:acknowledgeAttention'
    )?.[1]
    if (typeof handler !== 'function') {
      throw new Error('acknowledgement IPC not installed')
    }
    const accept = (accepted: NotificationAttentionAcknowledgement): void => {
      if (executionHost === undefined) {
        publish(accepted)
      } else {
        handler({}, accepted, executionHost)
      }
    }
    const deliveryId = (id: string): string =>
      executionHost ? JSON.stringify([executionHost, id]) : id

    accept({ worktree: { ...location, executionHostId: 'ssh:host-a' }, reads: [] })
    expect([...activeNotificationsById.keys()].sort()).toEqual(
      ['host-local-copy', 'local-copy', 'other-ssh', 'unknown-physical'].map(deliveryId)
    )
    expect(dismissedMobile).toEqual([deliveryId('ssh-read')])

    accept({ worktree: { ...location, executionHostId: localExecutionHostId }, reads: [] })
    expect([...activeNotificationsById.keys()].sort()).toEqual(
      ['other-ssh', 'unknown-physical'].map(deliveryId)
    )
    expect(dismissedMobile).toEqual(['ssh-read', 'local-copy', 'host-local-copy'].map(deliveryId))
  }
)

it('cancels a legacy delivery already awaiting macOS authorization without suppressing later alerts', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  installHandlers()
  const authorization = Promise.withResolvers<'authorized'>()
  readAuthorizationStatusMock.mockReturnValueOnce(authorization.promise)
  const pending = dispatch('in-flight')
  publish(acknowledgement())
  authorization.resolve('authorized')
  expect(await pending).toEqual({ delivered: false, reason: 'already-read' })
  expect(activeNotificationsById.has('in-flight')).toBe(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await dispatch('later')).toEqual({ delivered: true })
})

it('cancels pending native news when mobile cooldown prevented its announcement', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  installHandlers()
  await dispatch('mobile-only', {
    attentionKey: 'same-news',
    notificationSourceId: 'runtime:muted-host'
  })
  const authorization = Promise.withResolvers<'authorized'>()
  readAuthorizationStatusMock.mockReturnValueOnce(authorization.promise)
  const pending = dispatch('pending-native', { attentionKey: 'same-news' })

  publish(acknowledgement())
  authorization.resolve('authorized')

  expect(await pending).toEqual({ delivered: false, reason: 'already-read' })
  expect(activeNotificationsById.has('pending-native')).toBe(false)
  expect(dismissedMobile).toEqual(['mobile-only'])
  expect(await dispatch('later-news')).toEqual({ delivered: true })
})

it('releases failed native reservations without evicting unread announcements', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  installHandlers()
  await dispatch('unread', { paneKey: 'same-pane', mobileDeliveredByHost: true })
  readAuthorizationStatusMock.mockResolvedValue('denied')

  for (let index = 0; index < 20; index += 1) {
    expect(
      await dispatch(`blocked-${index}`, { paneKey: 'same-pane', mobileDeliveredByHost: true })
    ).toEqual({ delivered: false, reason: 'blocked-by-system' })
  }

  expect(activeNotificationsById.has('unread')).toBe(true)
  publish(acknowledgement())
  expect(activeNotificationsById.size).toBe(0)
  expect(dismissedMobile).toEqual([])
})

it.each(['linux', 'darwin'] as const)(
  'bounds %s native history without acknowledging unread phone alerts',
  async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    installHandlers()
    for (let index = 0; index < 21; index += 1) {
      await dispatch(`burst-${index}`, { paneKey: 'same-pane' })
    }
    expect(activeNotificationsById.has('burst-0')).toBe(false)
    expect(dismissedMobile).toEqual([])
    expect(notificationRemoveGroupMock).not.toHaveBeenCalled()
    publish(acknowledgement())
    expect(activeNotificationsById.size).toBe(0)
  }
)

it('removes the expired legacy macOS group while preserving newer id-only structured news in its pane', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  installHandlers()
  await dispatch('legacy-grouped', { paneKey: 'same-pane' })
  await dispatch('newer-positioned', { paneKey: 'same-pane', structuredOrigin: origin(6) })
  await vi.advanceTimersByTimeAsync(6 * 60_000)
  publish(acknowledgement())
  expect(notificationRemoveGroupMock).toHaveBeenCalledWith('pane:same-pane')
  expect(notificationRemoveMock).not.toHaveBeenCalledWith(['newer-positioned'])
  expect(dismissedMobile).toEqual(['legacy-grouped'])
})

it('keeps copied host and WSL phone identities on the existing UI pane-read route', async () => {
  await dispatch('ui-read', { paneKey: 'same-pane', structuredOrigin: origin(3) })
  await dispatch('wsl-copy', {
    paneKey: 'other-pane',
    structuredOrigin: origin(3, { wslDistro: 'Ubuntu' })
  })
  await dispatch('runtime-copy', { executionHost: 'runtime:remote', structuredOrigin: origin(3) })
  getDismissHandler()(
    {},
    [],
    ['same-pane'],
    [
      {
        paneKey: 'same-pane',
        sessionId: 'session',
        observedCursor: { epoch: 'journal', sequence: 5 }
      }
    ]
  )
  expect(dismissedMobile).toEqual(['ui-read'])
  expect([...activeNotificationsById.keys()].sort()).toEqual([
    '["runtime:remote","runtime-copy"]',
    'wsl-copy'
  ])
})

it('preserves distinct delivered copies when cloned hosts emit the same producer attention id', async () => {
  await dispatch('same-edge', { structuredOrigin: origin(3) })
  await dispatch('same-edge', { executionHost: 'runtime:remote', structuredOrigin: origin(3) })
  expect([...activeNotificationsById.keys()].sort()).toEqual([
    '["runtime:remote","same-edge"]',
    'same-edge'
  ])
  publish(acknowledgement())
  expect([...activeNotificationsById.keys()]).toEqual(['["runtime:remote","same-edge"]'])
  expect(dismissedMobile).toEqual(['same-edge'])
})

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
