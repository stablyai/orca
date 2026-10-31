import { beforeEach, expect, it, vi } from 'vitest'
import { stubRuntime } from '../runtime/rpc/terminal-multiplex-test-harness'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { AutomationRunOutcome } from '../../shared/automation-run-outcome'
const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  present: vi.fn(),
  close: vi.fn(),
  subscribe: vi.fn(),
  snapshots: vi.fn(),
  status: vi.fn(),
  generation: vi.fn()
}))
vi.mock('../ipc/notifications', () => ({ dispatchRegisteredNotification: mocks.dispatch }))
vi.mock('../notifications/app-notification-presentation', () => ({
  presentAppNotificationResult: mocks.present,
  closeAppNotificationPresentation: mocks.close
}))
vi.mock('../ipc/runtime-environments/runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusSnapshots: mocks.snapshots
}))
vi.mock('../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/fixture'
}))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-generation', () => ({
  getRuntimeEnvironmentTransportGeneration: mocks.generation
}))
vi.mock('../ipc/runtime-environments/runtime-environment-status-owner', () => ({
  onRuntimeEnvironmentStatusPublished: mocks.status
}))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
vi.mock('../../shared/runtime-environment-store', () => ({ listEnvironments: () => [] }))
import { startAutomationOutcomeNotifications } from './automation-outcome-notifications'

const settledRun: AutomationRunOutcome = {
  name: 'Check',
  agentId: 'claude',
  run: {
    id: 'run',
    automationId: 'auto',
    status: 'completed',
    sessionKind: 'chat',
    workspaceId: 'workspace',
    chatSessionId: 'chat',
    terminalPaneKey: null,
    terminalPtyId: null,
    dispatchedAt: 2,
    createdAt: 1
  }
}
let local: (event: RuntimeClientEvent) => void
let stopped = vi.fn<() => void>()
async function start() {
  stopped = vi.fn<() => void>()
  const runtime = stubRuntime({
    onClientEvent: vi.fn((listener) => {
      local = listener
      return stopped
    })
  })
  const { store } = await fixture()
  vi.spyOn(store, 'getSshTargets').mockReturnValue([])
  vi.spyOn(store, 'getWorkspaceSession').mockReturnValue({
    ...store.getWorkspaceSession(),
    activeWorktreeId: 'workspace'
  })
  vi.spyOn(store, 'getUI').mockReturnValue({ ...store.getUI(), activeView: 'automations' })
  const notifications = { ...store.getSettings().notifications, enabled: true }
  vi.spyOn(store, 'getSettings').mockReturnValue({ ...store.getSettings(), notifications })
  return { stop: startAutomationOutcomeNotifications(runtime, store), notifications }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.snapshots.mockReturnValue([])
  mocks.generation.mockReturnValue(1)
  mocks.status.mockReturnValue(vi.fn())
  mocks.subscribe.mockResolvedValue({ close: vi.fn() })
  mocks.dispatch.mockResolvedValue({ delivered: true })
})
it('delivers a live local outcome without a renderer, presents its sound/fallback, and tears down', async () => {
  const { stop, notifications } = await start()
  local({ type: 'automationsChanged', settledRun })
  await Promise.resolve()
  await Promise.resolve()
  expect(mocks.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      automationRun: { automationId: 'auto', runId: 'run' },
      isActiveWorktree: false
    })
  )
  expect(mocks.present).toHaveBeenCalledWith({ delivered: true }, notifications)
  stop()
  local({ type: 'automationsChanged', settledRun })
  expect(mocks.dispatch).toHaveBeenCalledOnce()
  expect(stopped).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalledOnce()
})
it('fences paired remote streams and never produces historical banners on replay', async () => {
  mocks.snapshots.mockReturnValue([
    {
      environmentId: 'server',
      verification: 'verified',
      transport: 'ready',
      pairingRevision: 4,
      status: { runtimeId: 'runtime', capabilities: ['automation.run-seen.v1'] }
    }
  ])
  const { stop } = await start()
  await Promise.resolve()
  expect(mocks.subscribe).toHaveBeenCalledOnce()
  const event = mocks.subscribe.mock.calls[0][5].onEvent
  const response = {
    type: 'response',
    response: { ok: true, result: { type: 'automationsChanged', settledRun } }
  }
  event({ ...response, response: { ...response.response, _replayedAfterReconnect: true } })
  expect(mocks.dispatch).not.toHaveBeenCalled()
  event(response)
  await Promise.resolve()
  expect(mocks.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      automationRun: {
        automationId: 'auto',
        runId: 'run',
        hostId: 'runtime:server',
        pairingRevision: 4
      }
    })
  )
  mocks.generation.mockReturnValue(2)
  event(response)
  expect(mocks.dispatch).toHaveBeenCalledOnce()
  stop()
})
it('does not subscribe to old or unverified hosts', async () => {
  mocks.snapshots.mockReturnValue([
    {
      environmentId: 'old',
      verification: 'verified',
      transport: 'ready',
      status: { capabilities: [] }
    }
  ])
  const { stop } = await start()
  expect(mocks.subscribe).not.toHaveBeenCalled()
  stop()
})
