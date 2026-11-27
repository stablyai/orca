import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../../rpc-test-harness'
import { runtimeBotGroups } from '../../../../../../bots/bot-group-runtime'
import { narrowGroupMailBatch } from '../../../../../../bots/bot-group-peer-requests'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestOperationId
} from '../../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readTestHostJournal } from '../../../../../../native-chat/agent-session-journal/journal-observation.test-support'
import { testOrcaSessionId } from '../../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { OrchestrationSessionCaller } from '../../../../../orchestration/addressing/orchestration-caller-identity'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'

const COORD = testOrcaSessionId('bot-group-member-lead')
const WORKER = testOrcaSessionId('engineer-home')
const OTHER = 'bot-group-member-other'
const QUESTION = 'Should pretty output use four spaces?'
const h = createOrchestrationRpcHarness()
let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  h.cleanup()
  vi.restoreAllMocks()
})

const caller = (sessionId: typeof COORD): OrchestrationSessionCaller => ({
  sessionId,
  orcaSessionId: sessionId,
  address: `orca_session_id:${sessionId}`,
  terminalHandle: null,
  paneKey: null,
  workspaceId: HOST_TEST_LOCATION.workspaceId
})

it('delivers a reused chat question only to the group member that assigned it', async () => {
  const current = await createQueuedMessageTestRig({ sessionId: COORD })
  rig = current
  setStructuredAgentSessionHost(current.host)
  const { db, runtime, ctx } = h.setup(false)
  vi.spyOn(runtime.bots, 'list').mockReturnValue([])
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reuse reads only these workspace identifiers.
    { id: HOST_TEST_LOCATION.workspaceId, repoId: 'repo' } as never
  )
  const groups = runtimeBotGroups(runtime)
  const operationId = await current.workingSend()
  await current.settleAccepted(operationId, 'lead-turn')
  current.providerEvents().appendLifecycleBatch!(
    'lead-running',
    [
      {
        kind: 'item',
        identity: {
          provider: 'codex',
          threadId: HOST_TEST_THREAD,
          turnId: 'lead-running',
          ordinal: 0
        },
        body: {
          kind: 'turn',
          turnId: 'lead-running',
          userItemId: agentJournalSubmissionKey(operationId),
          state: 'running',
          startedAt: HOST_TEST_NOW
        },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ],
    { lifecycle: true }
  )
  await current.host.flushStreamedEvents(COORD)
  groups.store.put({
    id: 'room',
    name: 'Engineering',
    hostId: 'local',
    revision: 1,
    folder: '/work/project',
    folderWorkspaceId: HOST_TEST_LOCATION.workspaceId,
    createdAt: 0,
    members: [
      { botId: 'lead', sessionId: COORD },
      { botId: 'other', sessionId: OTHER }
    ],
    replyMode: { kind: 'all' }
  })
  groups.store.append({
    id: 'owner-request',
    groupId: 'room',
    author: { kind: 'owner' },
    text: 'Ask Engineer to implement pretty output',
    createdAt: 0,
    turns: [
      {
        operationId,
        botId: 'lead',
        botName: 'Lead',
        avatar: null,
        agent: 'codex',
        sessionId: COORD
      }
    ]
  })
  const attached = await current.host.attach(
    QUEUED_RIG_CALLER,
    hostTestAttachParams(null, {
      envelope: {
        sessionId: WORKER,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      providerHandle: { kind: 'codex', threadId: 'engineer-thread' }
    })
  )
  expect(attached).toMatchObject({ ok: true })
  const coordinator = caller(COORD)
  const run = db.createRun({
    objective: 'Pretty output',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: COORD
  })
  const task = db.createTask({ spec: 'Implement pretty output', runId: run.id })
  const questions = () =>
    db.getAllMessagesForHandle(`run:${run.id}`).filter((mail) => mail.type === 'question')
  expect(await groups.captureWorkerOperation(COORD)).toBe(operationId)
  current.dispatch.mockResolvedValue({
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: 'engineer-thread',
      turnId: 'engineer-work',
      ordinal: 0
    }
  })
  const result = await h.call(
    'orchestration.workerStart',
    {
      run: run.id,
      task: task.id,
      from: coordinator.address,
      terminal: `orca_session_id:${WORKER}`,
      keepOpen: true
    },
    { ...ctx, orchestrationCaller: coordinator }
  )
  expect(result).toMatchObject({ state: 'ready' })
  await h.call(
    'orchestration.ask',
    { from: `orca_session_id:${WORKER}`, question: QUESTION, wait: false },
    { ...ctx, orchestrationCaller: caller(WORKER) }
  )
  expect(
    narrowGroupMailBatch(groups, COORD, questions()).messages.map((mail) => mail.body)
  ).toEqual([QUESTION])
  expect(narrowGroupMailBatch(groups, OTHER, questions()).messages).toEqual([])
  expect(
    (await readTestHostJournal(current.host, COORD)).items.filter(
      (item) => item.body.kind === 'agent-start'
    )
  ).toEqual([])
})
