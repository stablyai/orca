import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  createRestTestRig,
  foundRestTestChat,
  IDLE_MS,
  REST_TEST_SESSION,
  REST_TEST_THREAD,
  sweepOnce,
  type RestTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrcadIdleExitMonitor } from './orcad-idle-exit-monitor'
import { createOrcadIdleProbes } from './orcad-managed-idle-exit'

let rig: RestTestRig
const SERVER_IDLE_MS = 15 * 60_000

beforeEach(async () => {
  rig = await createRestTestRig()
  rig.host.collaboratorsForTests().lifetime.idleSweep.dispose()
  await foundRestTestChat(rig)
})

afterEach(async () => {
  await rig.dispose()
})

function idleMonitor() {
  const onIdle = vi.fn()
  const monitor = new OrcadIdleExitMonitor({
    timeoutMs: SERVER_IDLE_MS,
    now: () => rig.clock.now,
    log: () => {},
    lastClientActivityAt: () => 0,
    onIdle,
    probes: createOrcadIdleProbes(
      { timeoutMs: SERVER_IDLE_MS, activationRoot: 'test-fence' },
      {
        readClientActivity: () => ({ openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }),
        listTerminals: async () => [],
        countDaemonSessions: async () => 0,
        hasDaemon: () => true,
        hasChatProviders: () => rig.host.hasLoadedProviders(),
        agentStates: () => [{ state: 'blocked' }],
        hasStagedMigration: () => false,
        automationsBusy: () => false,
        activationFenceExists: async () => false
      }
    )
  })
  return { monitor, onIdle }
}

function providerEvents() {
  const events = rig.adapter.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('no provider was started')
  }
  return events
}

it('U2: keeps the provider and disconnected server alive while an approval is unanswered', async () => {
  providerEvents().appendItem(
    { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'approval-turn', ordinal: 70 },
    {
      kind: 'approval',
      title: 'Run the command?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.host.flushStreamedEvents(REST_TEST_SESSION)
  const { monitor, onIdle } = idleMonitor()
  expect(await monitor.check()).toBe(false)
  rig.clock.now += 7 * 24 * 60 * 60_000
  await sweepOnce(rig.host)

  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  expect(await monitor.check()).toBe(false)
  expect(onIdle).not.toHaveBeenCalled()
})

it('releases an idle provider after the existing window, then lets the disconnected server exit', async () => {
  const { monitor, onIdle } = idleMonitor()
  expect(await monitor.check()).toBe(false)
  rig.clock.now += IDLE_MS - 1
  await sweepOnce(rig.host)
  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  expect(await monitor.check()).toBe(false)

  rig.clock.now += 2
  await sweepOnce(rig.host)
  expect(rig.adapter.closeSession).toHaveBeenCalledWith(REST_TEST_SESSION)
  expect(rig.host.hasLoadedProviders()).toBe(false)
  expect(await monitor.check()).toBe(false)
  rig.clock.now += SERVER_IDLE_MS
  expect(await monitor.check()).toBe(true)
  expect(onIdle).toHaveBeenCalledOnce()
})

it('never releases a quiet running turn or idle-exits its server', async () => {
  providerEvents().appendItem(
    { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'working', ordinal: 71 },
    { kind: 'turn', turnId: 'working', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.host.flushStreamedEvents(REST_TEST_SESSION)
  const { monitor, onIdle } = idleMonitor()
  expect(await monitor.check()).toBe(false)
  for (let pass = 0; pass < 3; pass += 1) {
    rig.clock.now += 7 * 24 * 60 * 60_000
    await sweepOnce(rig.host)
    expect(await monitor.check()).toBe(false)
  }
  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  expect(onIdle).not.toHaveBeenCalled()
})
