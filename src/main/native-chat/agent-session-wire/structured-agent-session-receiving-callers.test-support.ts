import {
  receivingPersistedFixtures,
  receivingRuntimeStore
} from './structured-agent-session-receiving-persisted.test-support'
import { expect, vi } from 'vitest'
import { getAppEnvironment, setAppEnvironment } from '../../../shared/app-environment'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { ClaudeAccountRecipe } from '../../../shared/agent-session-acquired-account'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OrchestrationSessionCaller } from '../../runtime/orchestration/orchestration-caller-identity'
import { resolveOrcaSessionParty } from '../../runtime/orchestration/orchestration-party'
import { ReceivingRuntime } from './structured-agent-session-receiving-runtime.test-support'
import { eraseRpcMethods, isStreamingMethod } from '../../runtime/rpc/core'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import { ORCHESTRATION_METHODS } from '../../runtime/rpc/methods/orchestration'
import { resolveWorkerStartRun } from '../../runtime/rpc/methods/orchestration/worker/worker-start-authority'
import { resolveDispatchCreator } from '../../runtime/rpc/methods/orchestration/runs/dispatch-creator'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../runtime/structured-worker-identity'
import { structuredNativeWorkReaders } from '../../runtime/structured-native-work-readers'
import { createRestTestRig, REST_TEST_CALLER } from './structured-agent-session-rest-test-rig'
import {
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

export const PARENT = testOrcaSessionId('cfe50e96-3a95-4353-9cdc-7a652779c6e8')
export const WORKER = testOrcaSessionId('4c1b8d7a-975c-4984-a2e4-8149fdd4177a')
export const HELPER = testOrcaSessionId('8e2ab9f7-0ad7-43f0-9241-539b1e4c5bc7')
export const HOME_A = { variable: 'CLAUDE_CONFIG_DIR', path: '/qa/claude/a' }
export const HOME_B = { variable: 'CLAUDE_CONFIG_DIR', path: '/qa/claude/b' }

/** Script only external adapter IO; reservation, proof, journals, RPC and native transactions are real. */
export async function createReceivingCallerFixture(options: { reportsRecipe?: boolean } = {}) {
  const previousEnvironment = getAppEnvironment()
  let selected = HOME_A
  let runtime: ReceivingRuntime | undefined
  const readers = structuredNativeWorkReaders(
    () => runtime?.getOrchestrationDbIfAvailable() ?? null,
    () => runtime?.getExistingOrchestrationDb() ?? null
  )
  const rig = await createRestTestRig({ ...readers, launchAccountHome: async () => selected })
  setAppEnvironment({
    ...previousEnvironment,
    getPath: (name) => (name === 'userData' ? rig.root : previousEnvironment.getPath(name))
  })
  const runtimeStore = receivingRuntimeStore(rig.root)
  const service = new ReceivingRuntime(runtimeStore)
  runtime = service
  // Scheduling is externally controlled; nested contracts drive the production pointer park/wake.
  const nudges = vi.spyOn(service, 'notifyMessageArrived').mockImplementation(() => {})
  rig.host.deps.adapter.supportsLocation = (location) =>
    location.executionHostId === 'local' && !location.wslDistro
  setStructuredAgentSessionHost(rig.host)
  const sinks = new Map<string, StructuredAgentSessionEventSink>()
  let generation = 0
  rig.adapter.acquire.mockImplementation(async (input) => {
    const recipe: ClaudeAccountRecipe = input.accountRecipe ?? {
      route: 'system',
      home: selected.path,
      configDir: selected.path
    }
    if (input.events) {
      sinks.set(input.identity.sessionId, input.events)
    }
    return {
      acquisitionGeneration: `caller-generation-${++generation}`,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: recipe.home },
      ...(options.reportsRecipe === false ? {} : { accountRecipe: recipe }),
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: 1_700_000_000_000,
        spawnToken: input.spawnToken
      },
      link: {
        linkId: `caller-link-${generation}`,
        handle: claudeProviderHandle(`provider-${input.identity.sessionId}`, null),
        origin: rig.store.getRecord(input.identity.sessionId)?.providerHandleChain.length
          ? 'resumed'
          : 'created',
        mintedAtFence: input.fence,
        observedAt: rig.clock.now
      }
    }
  })
  rig.adapter.dispatch.mockImplementation(async (input) => ({
    state: 'accepted',
    providerIdentity: {
      provider: 'claude',
      sessionId: `provider-${input.sessionId}`,
      uuid: `echo-${input.clientMessageId}`
    }
  }))
  vi.spyOn(service, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  const params = (id = PARENT) =>
    hostTestAttachParams(rig.store.getRecord(id)?.lease.runtimeFence ?? null, {
      envelope: {
        sessionId: id,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: rig.store.getRecord(id)?.lease.runtimeFence ?? null,
        payloadFingerprint: ''
      },
      provider: 'claude',
      agent: 'claude',
      accountHome: HOME_A,
      providerHandle: { kind: 'claude', sessionId: `provider-${id}`, leafUuid: null }
    })
  const ensure = async (id = PARENT) => {
    const method = eraseRpcMethods(STRUCTURED_AGENT_SESSION_METHODS).find(
      (m) => m.name === 'agentSession.ensure'
    )
    if (!method?.params || isStreamingMethod(method)) {
      throw new Error('registered ensure missing')
    }
    return method.handler(method.params.parse(params(id)), { runtime: service })
  }
  const call = async (
    name: string,
    values: Record<string, unknown>,
    caller?: OrchestrationSessionCaller
  ) => {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find((m) => m.name === name)
    if (!method?.params) {
      throw new Error(`registered method missing: ${name}`)
    }
    return method.handler(method.params.parse(values), {
      runtime: service,
      ...(caller ? { orchestrationCaller: caller } : {})
    })
  }
  const caller = (id = PARENT): OrchestrationSessionCaller => ({
    ...resolveOrcaSessionParty(id, service.getExistingOrchestrationDb()),
    sessionId: id,
    workspaceId: 'workspace-1'
  })
  const accept = async (text: string, body: AgentJournalMessageItem = hostTestMessage(text)) => {
    const id = hostTestOperationId()
    const result = await rig.host.send(REST_TEST_CALLER, {
      body,
      envelope: {
        sessionId: PARENT,
        clientOperationId: id,
        expectedRuntimeFence: rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: PARENT,
          fields: { body }
        })
      }
    })
    expect(result.ok).toBe(true)
    return id
  }
  const send = async (text: string, body: AgentJournalMessageItem = hostTestMessage(text)) => {
    const id = await accept(text, body)
    await vi.waitFor(() =>
      expect(
        rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal.submission(id)?.dispatchState
      ).toBe('accepted')
    )
    return id
  }
  const turn = async (id: string, state: 'running' | 'completed', userId = id) => {
    const sink = sinks.get(PARENT)
    if (!sink) {
      throw new Error('parent was not actually acquired')
    }
    sink.appendItem(
      { provider: 'claude', sessionId: `provider-${PARENT}`, uuid: `turn-${id}` },
      {
        kind: 'turn',
        turnId: `turn-${id}`,
        state,
        userItemId: agentJournalSubmissionKey(userId),
        ...(state === 'completed' ? { outcome: 'success', completedAt: rig.clock.now } : {})
      },
      { turnScope: { kind: 'thread' } }
    )
    await rig.host.flushStreamedEvents(PARENT)
  }
  const createWorker = async (id: typeof WORKER | typeof HELPER, creator = PARENT) => {
    const from = caller(creator)
    const taskSpec = `work for ${id}`
    const { bindRun, helperCreator } = resolveWorkerStartRun(service, {
      coordinator: from,
      from: from.address,
      callerSession: from,
      runId: undefined,
      objective: taskSpec,
      taskReferences: []
    })
    const { run } = bindRun()
    const db = service.getOrchestrationDb()
    const started = db.createStartingWorkerDispatch({
      creator: resolveDispatchCreator(service, from.address, from),
      maxDepth: 9,
      requiredCreatorDispatchId: helperCreator?.id,
      taskSpec,
      taskParentId: helperCreator?.task_id,
      taskRunId: run.id,
      taskCreatedByRunGeneration: run.consumer_generation,
      startOptions: {},
      runtimeEpoch: service.getRuntimeId()
    })
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(id)
    const processIncarnation = structuredWorkerProcessIncarnation(id)
    structuredWorkerIdentities.register({
      handle,
      paneKey,
      processIncarnation,
      sessionId: id,
      agent: 'claude',
      worktreeId: 'workspace-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    await ensure(id)
    await rig.store.setSessionTabVisibility(id, true)
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey,
      processIncarnation,
      worktreeId: 'workspace-1',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: handle }],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { ...started, handle, paneKey, processIncarnation, sessionId: id }
  }
  const report = (worker: Awaited<ReturnType<typeof createWorker>>) =>
    call(
      'orchestration.send',
      {
        from: worker.handle,
        type: 'worker_done',
        subject: 'completed',
        payload: JSON.stringify({
          taskId: worker.task.id,
          dispatchId: worker.dispatch.id,
          outcome: 'succeeded'
        })
      },
      caller(worker.sessionId)
    )
  return {
    rig,
    runtime: service,
    params,
    ensure,
    call,
    caller,
    send,
    accept,
    turn,
    createWorker,
    report,
    sinks,
    nudges,
    selectB: () => {
      selected = HOME_B
    },
    ...receivingPersistedFixtures({ rig, params }),
    found: async () => {
      await ensure()
      await rig.store.setSessionTabVisibility(PARENT, true)
      if (options.reportsRecipe !== false) {
        expect(rig.store.requireWritableRecord(PARENT).acquiredAccount).toBeDefined()
      }
    },
    dispose: async (
      stopHost = () => rig.host.flushAllStreamedEvents(),
      disposeRig = () => rig.dispose()
    ) => {
      service.stopOrchestrationFederationRelay()
      setStructuredAgentSessionHost(null)
      structuredWorkerIdentities.clear()
      await stopHost()
      service.getOrchestrationDbIfAvailable()?.close()
      await runtimeStore.freezeWritesAsync()
      await disposeRig()
      setAppEnvironment(previousEnvironment)
      vi.restoreAllMocks()
    }
  }
}
