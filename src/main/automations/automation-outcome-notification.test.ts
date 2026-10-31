import {
  isAutomationRunOutcome,
  type AutomationRunOutcome
} from '../../shared/automation-run-outcome'
import { buildNotificationOptions } from '../ipc/notification-options'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { stubRuntime } from '../runtime/rpc/terminal-multiplex-test-harness'
import { describe, expect, it, vi } from 'vitest'
import {
  automationOutcomeNotification,
  publishAutomationOutcome
} from './automation-outcome-notification'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'
import type { NotificationSettings } from '../../shared/notification-settings-types'

function outcome(overrides: Partial<AutomationRunOutcome['run']> = {}): AutomationRunOutcome {
  return {
    name: 'Daily check',
    agentId: 'claude',
    run: {
      id: 'run',
      automationId: 'automation',
      status: 'completed',
      sessionKind: 'chat',
      workspaceId: 'workspace',
      chatSessionId: 'chat',
      terminalPaneKey: null,
      terminalPtyId: null,
      dispatchedAt: 2,
      createdAt: 1,
      ...overrides
    }
  }
}

describe('automation outcome requests', () => {
  it.each(['completed', 'dispatch_failed'] as const)(
    'routes %s to the common completion gates and run click target',
    (status) => {
      expect(
        automationOutcomeNotification(outcome({ status }), { hostId: 'runtime:server' })
      ).toMatchObject({
        source: 'agent-task-complete',
        agentState: 'done',
        agentTurnOutcome: status === 'completed' ? 'success' : 'failure',
        automationRun: { automationId: 'automation', runId: 'run', hostId: 'runtime:server' },
        executionHost: 'runtime:server'
      })
      expect(automationOutcomeNotification(outcome())?.attentionKey).not.toBe(
        automationOutcomeNotification(outcome(), { hostId: 'runtime:server' })?.attentionKey
      )
    }
  )
  it('leaves Terminal alerts to their existing producer but includes failures before any agent starts', () => {
    expect(automationOutcomeNotification(outcome({ sessionKind: 'terminal' }))).toBeNull()
    expect(
      automationOutcomeNotification(outcome({ sessionKind: 'terminal', status: 'dispatch_failed' }))
    ).toBeNull()
    expect(
      automationOutcomeNotification(
        outcome({
          sessionKind: 'terminal',
          status: 'dispatch_failed',
          dispatchedAt: null,
          chatSessionId: null
        })
      )
    ).toMatchObject({ agentTurnOutcome: 'failure' })
  })
})

it('honors the existing switches while hidden-workspace list settings do not mute outcomes', async () => {
  const settings: NotificationSettings = {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: true,
    suppressWhenFocused: false,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 100,
    mutedNotificationSourceIds: [],
    notifyHiddenWorkspaces: false
  }
  const native = vi.fn(() => ({ delivered: true }))
  const service = createNotificationDeliveryService({
    readNotificationSettings: () => settings,
    findActiveWindow: () => null,
    isWindowVisible: () => false,
    setTrayAttention: vi.fn(),
    isNotificationSupported: () => true,
    dispatchMobileNotification: null,
    readAuthorizationStatus: async () => 'authorized',
    recordDeliveryOutcome: vi.fn(),
    deliverNative: native,
    platform: 'linux',
    now: () => 100_000
  })
  const request = automationOutcomeNotification(outcome())
  if (!request) {
    throw new Error('missing outcome request')
  }
  expect(await service.dispatch(request)).toEqual({ delivered: true })
  settings.enabled = false
  expect(await service.dispatch({ ...request, attentionKey: 'disabled' })).toMatchObject({
    delivered: false,
    reason: 'disabled'
  })
  settings.enabled = true
  settings.agentTaskComplete = false
  expect(await service.dispatch({ ...request, attentionKey: 'type-disabled' })).toMatchObject({
    delivered: false,
    reason: 'source-disabled'
  })
  expect(native).toHaveBeenCalledOnce()
})

it.each(['completed', 'dispatch_failed'] as const)(
  'publishes one host-owned mobile %s result and retains the desktop outcome descriptor',
  async (status) => {
    const dispatchMobileNotification = vi.fn()
    const notifyAutomationsChanged = vi.fn()
    const runtime = stubRuntime({
      dispatchMobileNotification,
      notifyAutomationsChanged
    })
    const settings = { enabled: false, agentTaskComplete: true }
    const { store } = await fixture()
    vi.spyOn(store, 'getSettings').mockReturnValue({
      ...store.getSettings(),
      notifications: { ...store.getSettings().notifications, ...settings }
    })
    const settledRun = outcome({ status })
    publishAutomationOutcome(runtime, store, { reason: 'run', settledRun })
    expect(dispatchMobileNotification).toHaveBeenCalledOnce()
    expect(dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopAllowed: false,
        agentState: 'done',
        worktreeId: 'workspace'
      })
    )
    expect(notifyAutomationsChanged).toHaveBeenCalledWith({
      reason: 'run',
      settledRun: { ...settledRun, mobileDeliveredByHost: true }
    })
  }
)

it.each([true, false])(
  'sends the real outcome through unchanged phone live/replay routing (workspace=%s) without acknowledging',
  async (workspace) => {
    const { RuntimeMobileNotificationController } =
      await import('../runtime/runtime-mobile-notification-controller')
    const { store } = await fixture()
    const automation = store.listAutomations()[0]
    const run = store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
    store.updateAutomationRun({ runId: run.id, status: 'dispatch_failed' })
    const seen = vi.spyOn(store, 'markAutomationRunSeen')
    const phone = new RuntimeMobileNotificationController()
    const delivered = vi.fn()
    const stop = phone.onDispatched(delivered)
    const runtime = stubRuntime({
      dispatchMobileNotification: phone.dispatch.bind(phone),
      notifyAutomationsChanged: vi.fn()
    })
    publishAutomationOutcome(runtime, store, {
      settledRun: {
        ...outcome(),
        run: {
          ...outcome().run,
          id: run.id,
          automationId: automation.id,
          status: 'dispatch_failed',
          workspaceId: workspace ? 'workspace' : null,
          chatSessionId: workspace ? 'chat' : null,
          dispatchedAt: workspace ? 2 : null
        }
      }
    })
    expect(delivered).toHaveBeenCalledOnce()
    const event = delivered.mock.calls[0][0]
    expect(event).toMatchObject({
      type: 'notification',
      source: 'agent-task-complete',
      agentState: 'done'
    })
    expect(event.worktreeId).toBe(workspace ? 'workspace' : undefined)
    expect(event.paneKey === undefined || typeof event.paneKey === 'string').toBe(true)
    expect(phone.getMissedSince(0)).toMatchObject([event])
    expect(seen).not.toHaveBeenCalled()
    expect(
      store.listAutomationRuns().find((row) => row.id === run.id)?.failureSeenAt
    ).toBeUndefined()
    stop()
  }
)

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it.each([
  undefined,
  {
    failure: { errorCode: 'futureProviderCode', errorParams: { raw: 'PRIVATE provider detail' } },
    assistantMessage: 'x'.repeat(201)
  },
  {
    failure: { errorCode: 'projectSetupNotReady', errorParams: { setupState: 'PRIVATE unknown' } },
    origin: { sessionId: 'chat' }
  },
  { failure: { errorCode: 'wslDistroStopped', errorParams: { distro: 'PRIVATE\nprovider' } } }
])(
  'keeps a valid base and safe actionable failure fallback for optional context %j',
  (presentation) => {
    const wire: unknown = {
      ...outcome({
        status: 'dispatch_failed',
        dispatchedAt: null,
        workspaceId: null,
        chatSessionId: null
      }),
      presentation
    }
    expect(isAutomationRunOutcome(wire)).toBe(true)
    if (!isAutomationRunOutcome(wire)) {
      throw new Error('Expected valid base outcome')
    }
    const request = automationOutcomeNotification(wire)
    if (!request) {
      throw new Error('Missing pane-less failure request')
    }
    const options = buildNotificationOptions(request)
    expect(options.body).toBe(
      'Claude could not complete this automation. Review the run and try again.'
    )
    expect(request.structuredOrigin).toBeUndefined()
    expect(request.agentLastAssistantMessage).toBeUndefined()
    expect(options.body).not.toContain('PRIVATE')
    expect(options.body).not.toContain('never started')
  }
)

it('validates preview/origin correspondence without erasing a safe known coded reason', () => {
  const current = outcome({ status: 'dispatch_failed' })
  current.presentation = {
    assistantMessage: 'Exact reply',
    failure: { errorCode: 'agentNoCompletion' },
    origin: {
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'other-workspace',
        workspaceKind: 'folder'
      },
      sessionId: 'other-session',
      journalCursor: { epoch: 'epoch', sequence: 8 },
      cause: { kind: 'completion', requestId: 'turn' }
    }
  }
  const request = automationOutcomeNotification(current)
  if (!request) {
    throw new Error('Expected failure request')
  }
  expect(request.structuredOrigin).toBeUndefined()
  expect(buildNotificationOptions(request).body).toBe(
    'Claude: Automation agent did not report completion. Review the run and try again.'
  )
  expect(request.agentLastAssistantMessage).toBe('Exact reply')
})
