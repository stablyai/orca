import { afterEach, expect, it, vi } from 'vitest'
import type * as PrecheckRunner from './precheck-runner'
import { setup, listen, complete } from './automation-chat-notification-test-fixture'
import {
  fixture,
  deferred
} from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { AutomationService } from './service'
import { observeAutomationChatRun } from './runtime-chat-run-observer'
import { automationRunOperationId, AUTOMATION_AGENT_CALLER } from './automation-run-operation'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import { stubRuntime } from '../runtime/rpc/terminal-multiplex-test-harness'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { eventually } from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { resolveAutomationRunTarget } from './run-target-resolution'
import { STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS } from '../runtime/rpc/methods/structured-agent-session-turn-completion-stream'
import { eraseRpcMethods, isStreamingMethod } from '../runtime/rpc/core'

const held = vi.hoisted(() => {
  const initial: { host: StructuredAgentSessionHost | null; precheck: ReturnType<typeof vi.fn> } = {
    host: null,
    precheck: vi.fn()
  }
  return initial
})
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => held.host
}))
vi.mock('./precheck-runner', async (original) => ({
  ...(await original<typeof PrecheckRunner>()),
  runAutomationPrecheck: held.precheck
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
afterEach(() => {
  held.host = null
})

it('delivers B while real scheduled A parks, closes/reconnects, then settles A exactly once after its precheck wake', async () => {
  const rig = await setup()
  held.host = rig.host
  const { store } = await fixture()
  store.addRepo({
    id: 'dispatch-repo',
    path: '/repo',
    displayName: 'Dispatch',
    badgeColor: '#fff',
    addedAt: 1
  })
  const automation = store.createAutomation({
    name: 'A',
    prompt: 'A',
    projectId: 'dispatch-repo',
    agentId: 'codex',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1_800_000_000_000,
    surface: 'chat',
    precheck: { command: 'external-fixture-check', timeoutSeconds: 600 }
  })
  const run = store.createAutomationRun(automation, 1_800_000_000_000, 'scheduled')
  const gate = deferred<void>()
  held.precheck.mockImplementation(async () => {
    await gate.promise
    return {
      command: 'external-fixture-check',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
      startedAt: 1_800_000_000_000,
      completedAt: 1_800_000_000_001
    }
  })
  const cleanups = new Map<string, () => void>()
  const runtime = stubRuntime({
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => rig.store,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    }
  })
  const publish = vi.fn()
  let message = ''
  const service = new AutomationService(store, {
    allowRemoteHostScheduling: true,
    onAutomationsChanged: publish,
    chatDispatcher: async () => {
      message = automationRunOperationId(run, 'reuse-send')
      rig.host.registerAutomationChatRun(run.id, SESSION, message)
      const fields = { body: hostTestMessage('A') }
      expect(
        await rig.host.send(
          { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
          { ...fields, envelope: rig.envelope(fields, 'agentSession.send', message) }
        )
      ).toMatchObject({ ok: true })
      return {
        workspaceId: 'workspace-1',
        sessionKind: 'chat',
        chatSessionId: SESSION,
        terminalSessionId: null
      }
    },
    terminalObserver: {
      resolveRunTerminal: () => 'chat',
      observeCompletion: (_handle, { run, signal }) =>
        observeAutomationChatRun(runtime, run!, signal)
    }
  })
  const listener = listen(rig)
  const stream = eraseRpcMethods(STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS).find(
    (method) => method.name === 'agentSession.subscribeTurnCompletions'
  )!
  if (!isStreamingMethod(stream)) {
    throw new Error('stream missing')
  }
  const edges: unknown[] = []
  const abort = new AbortController()
  await stream.handler(
    { includePrompts: true },
    { runtime, requestId: 'B-stream', signal: abort.signal },
    (event) => edges.push(event)
  )
  const target = resolveAutomationRunTarget(store, automation, { allowRemoteHostScheduling: true })
  expect(target).toMatchObject({ ok: true })
  const dispatch = service['requestDispatch'](automation, run, target, 0)
  try {
    await eventually(() => expect(held.precheck).toHaveBeenCalledOnce())
    const human = rig.send('ordinary B')
    await human.result
    await complete(rig, human.id, 'ordinary-B')
    expect(edges).toContainEqual(
      expect.objectContaining({
        type: 'completion',
        completion: expect.objectContaining({ turnId: 'ordinary-B' })
      })
    )
    expect(listener.phone).toHaveBeenCalledOnce()
    expect(message).toBe('')
    abort.abort()
    const reconnect: unknown[] = []
    await stream.handler({ includePrompts: true }, { runtime, requestId: 'B-reconnect' }, (event) =>
      reconnect.push(event)
    )
    expect(reconnect).toEqual([])
    gate.resolve()
    await dispatch
    await complete(rig, message, 'actual-A')
    await eventually(() =>
      expect(
        publish.mock.calls.flatMap(([event]) => (event.settledRun ? [event.settledRun.run.id] : []))
      ).toEqual([run.id])
    )
    expect(store.listAutomationRuns().find((row) => row.id === run.id)?.status).toBe('completed')
    expect(reconnect).toContainEqual(
      expect.objectContaining({
        type: 'completion',
        completion: expect.objectContaining({ turnId: 'actual-A', automationOwned: true })
      })
    )
    expect(listener.phone).toHaveBeenCalledOnce()
    expect(rig.dispatch).toHaveBeenCalledTimes(2)
  } finally {
    gate.resolve()
    await dispatch
    service.stop()
    listener.stop()
    for (const cleanup of cleanups.values()) {
      cleanup()
    }
  }
})

it('keeps a finished exact root owned when withdrawal exposes it after its outcome observer ends', async () => {
  const rig = await setup()
  held.host = rig.host
  const { store } = await fixture()
  const automation = store.listAutomations()[0]
  const run = store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
  const message = automationRunOperationId(run, 'reuse-send')
  rig.host.registerAutomationChatRun(run.id, SESSION, message)
  const fields = { body: hostTestMessage('owned root') }
  expect(
    await rig.host.send(
      { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
      { ...fields, envelope: rig.envelope(fields, 'agentSession.send', message) }
    )
  ).toMatchObject({ ok: true })
  const accepted = store.updateAutomationRun({
    runId: run.id,
    status: 'dispatched',
    sessionKind: 'chat',
    chatSessionId: SESSION,
    workspaceId: 'workspace-1'
  })
  const runtime = stubRuntime({
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => rig.store
  })
  const observed = observeAutomationChatRun(runtime, accepted, new AbortController().signal)
  const listener = listen(rig)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
  const human = rig.send('human admitted behind automation')
  await human.result
  await complete(rig, message, 'older-owned-root')
  expect(await observed).toMatchObject({ status: 'completed' })
  expect(rig.host.collaboratorsForTests().sessions['observers'].size).toBe(0)
  expect(listener.events[0].filter((event) => event.type === 'completion')).toHaveLength(0)
  expect(await rig.stop()).toMatchObject({ ok: true })
  await rig.host.flushStreamedEvents(SESSION)
  expect(listener.events[0].filter((event) => event.type === 'completion')).toEqual([
    expect.objectContaining({
      completion: expect.objectContaining({ turnId: 'older-owned-root', automationOwned: true })
    })
  ])
  expect(listener.phone).not.toHaveBeenCalled()
  listener.stop()
})

it('restores retained final and nonfinal receipts before adoption, then retires claims on prune, delete and service end', async () => {
  const { createRuntimeAutomationService } = await import('./runtime-automation-service')
  const rig = await setup()
  held.host = rig.host
  const { store } = await fixture()
  const automation = store.listAutomations()[0]
  const retained = []
  for (const status of ['completed', 'dispatched'] as const) {
    const run = store.createAutomationRun(automation, 1_800_000_000_000 + retained.length, 'manual')
    const id = automationRunOperationId(run, 'reuse-send')
    const fields = { body: hostTestMessage(status) }
    expect(
      await rig.host.send(
        { callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER) },
        { ...fields, envelope: rig.envelope(fields, 'agentSession.send', id) }
      )
    ).toMatchObject({ ok: true })
    if (status === 'completed') {
      await complete(rig, id, 'retained-final-root')
    }
    store.updateAutomationRun({
      runId: run.id,
      status,
      sessionKind: 'chat',
      chatSessionId: SESSION,
      workspaceId: 'workspace-1'
    })
    retained.push(run)
  }
  await store.flushPendingOrThrowAsync()
  await rig.restartHostProcess()
  held.host = rig.host
  const runtime = stubRuntime({
    setAutomationService: () => {},
    getAgentStatusRowsForPane: () => [],
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => rig.store
  })
  const service = createRuntimeAutomationService({ store, runtime, headless: false })
  try {
    service.attachChatOwnership?.(rig.host, rig.store)
    const owner = rig.host.automationChatInterests
    expect(owner['runs'].size).toBe(2)
    const listener = listen(rig)
    await rig.host.journalSnapshot(SESSION)
    expect(listener.events[0]).toEqual([])
    expect(owner.owns(SESSION, { kind: 'turn', id: 'retained-final-root' })).toBe(true)
    expect(owner.identity(retained[1].id)).toBeDefined()
    const human = rig.send('after restart')
    await human.result
    await complete(rig, human.id, 'human-after-restart')
    expect(listener.phone).toHaveBeenCalledOnce()
    let clock = 1_800_000_000_100
    vi.spyOn(Date, 'now').mockImplementation(() => clock++)
    for (let index = 0; index < 101; index++) {
      const newer = store.createAutomationRun(automation, 1_800_000_001_000 + index, 'manual')
      store.updateAutomationRun({ runId: newer.id, status: 'completed' })
    }
    expect(store.hasAutomationRun(retained[0].id)).toBe(false)
    expect(owner.identity(retained[0].id)).toBeUndefined()
    store.deleteAutomation(automation.id)
    expect(owner['runs'].size).toBe(0)
    rig.host.registerAutomationChatRun('teardown', SESSION, 'teardown-message')
    service.stop()
    expect(owner['runs'].size).toBe(0)
    expect(owner['sessions'].size).toBe(0)
    listener.stop()
  } finally {
    service.stop()
  }
})
