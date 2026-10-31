import '../../unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../../shared/agent-session-journal-types'
import {
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  type RestTestRig
} from '../../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrchestrationDb } from '../../../orchestration/db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../structured-worker-identity'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcResponse } from '../../core'
import { ORCHESTRATION_SESSION_CHILDREN_METHODS } from './session-children'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../structured-agent-session'

const PARENT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const WORKER = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
let rig: RestTestRig | undefined
let db: OrchestrationDb | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  db?.close()
  await rig?.dispose()
})

it('opens released worker history and a live reader through RPC without acquiring any provider or Task ownership', async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  for (const sessionId of [PARENT, WORKER]) {
    const attached = await rig.host.attach(
      REST_TEST_CALLER,
      hostTestAttachParams(null, {
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: '0'.repeat(64)
        },
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'folder'
        }
      })
    )
    expect(attached.ok).toBe(true)
  }
  const body = hostTestMessage('Full original worker instruction')
  const sent = await rig.host.send(REST_TEST_CALLER, {
    envelope: {
      sessionId: WORKER,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: rig.store.getRecord(WORKER)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: WORKER,
        fields: { body }
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(sent.refusal.code)
  }
  await rig.host.waitForSendSettlement(WORKER, sent.value.clientMessageId)
  const events = rig.adapter.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('The worker did not start for the fixture')
  }
  const items: AgentJournalItemBody[] = [
    {
      kind: 'tool-call',
      name: 'read_file',
      input: { path: 'source.ts' },
      state: 'completed',
      output: { head: 'Public tool output', byteLength: 18, digest: 'fixture', truncated: false }
    },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Full original recorded answer' }]
    }
  ]
  for (const [ordinal, item] of items.entries()) {
    events.appendItem(
      {
        provider: 'codex',
        threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60',
        turnId: 'worker-turn',
        ordinal: ordinal + 100
      },
      item,
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await rig.host.flushAllStreamedEvents()
  await rig.host.close(WORKER, 'user-close')
  await rig.store.setSessionTabVisibility(WORKER, false)

  db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'Inspect',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: PARENT
  })
  const started = db.createStartingWorkerDispatch({
    taskSpec: 'Worker',
    taskRunId: run.id,
    startOptions: {},
    creator: { kind: 'session', orcaSessionId: PARENT },
    maxDepth: 10
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: mintStructuredWorkerHandle(),
    paneKey: mintStructuredWorkerPaneKey(WORKER),
    processIncarnation: structuredWorkerProcessIncarnation(WORKER),
    worktreeId: 'workspace-1',
    effects: [],
    setupState: 'ready',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  db.settleWorkerReport({
    taskId: started.task.id,
    dispatchId: started.dispatch.id,
    outcome: 'succeeded',
    result: 'Full original recorded answer'
  })
  const resource = db.getWorkerTerminalResourceByOwner(started.dispatch.id)!
  db.settleDeadWorkerTerminalRelease({
    requestingDispatchId: started.dispatch.id,
    resourceId: resource.id,
    processIncarnation: resource.process_incarnation!
  })
  await rig.restart()
  setStructuredAgentSessionHost(rig.host)
  rig.adapter.acquire.mockClear()
  rig.adapter.dispatch.mockClear()
  const lease = rig.store.getRecord(WORKER)?.lease
  const dispatch = db.getDispatchContextById(started.dispatch.id)

  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(db)
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...ORCHESTRATION_SESSION_CHILDREN_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS]
  })
  let request = 0
  async function call(method: string, params: unknown) {
    const replies: RpcResponse[] = []
    await dispatcher.dispatchStreaming(
      { id: `read-${++request}`, authToken: 'token', method, params },
      (raw) => replies.push(JSON.parse(raw)),
      {
        clientId: 'reader',
        clientKind: 'runtime',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        connectionId: 'reader-connection'
      }
    )
    return replies
  }
  expect(await call('orchestration.sessionChildren', { sessionId: PARENT })).toMatchObject([
    {
      ok: true,
      result: {
        children: [
          {
            dispatchId: started.dispatch.id,
            state: 'completed',
            result: 'Full original recorded answer',
            conversation: { kind: 'journal', sessionId: WORKER }
          }
        ]
      }
    }
  ])
  const history = await call('agentSession.history', { sessionId: WORKER, direction: 'tail' })
  const subscription = await call('agentSession.subscribe', { sessionId: WORKER })
  expect(history[0]?.ok).toBe(true)
  for (const text of [
    'Full original worker instruction',
    'Public tool output',
    'Full original recorded answer'
  ]) {
    expect(JSON.stringify(history)).toContain(text)
    expect(JSON.stringify(subscription)).toContain(text)
  }
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  expect(rig.store.getRecord(WORKER)?.lease).toEqual(lease)
  expect(db.getDispatchContextById(started.dispatch.id)).toEqual(dispatch)
})
