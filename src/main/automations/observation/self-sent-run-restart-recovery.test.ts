import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { agentSessionMessagePayload } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { automationRunOperationId } from '../launch/automation-run-operation'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import { sendRunPromptKeptAtRestart } from './self-sent-run-restart-recovery'
import { selfSentRunPlacement } from './self-sent-run-placement'

/** Where the run's prompt went, as recovery reads it. */
const placementOf = (runtime: OrcaRuntimeService, of: { id: string; createdAt: number }) =>
  selfSentRunPlacement(runtime, of)

// Orca quit while a self-sent run's prompt waited for its agent to start: after the restart, the run finds
// its chat by the prompt's id and sends the kept prompt exactly once, however often recovery runs.
let rig: QueuedMessageTestRig | null = null
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(async () => {
  vi.useRealTimers()
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = null
})

const run = { id: 'run-1', createdAt: NOW, chatSessionId: SESSION } satisfies Partial<AutomationRun>
const messageId = automationRunOperationId(run, 'run-message')
const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'Daily: report.' }]
}

/** The run's prompt, sent as the run sends it: under its run-derived id, queued behind any turn. */
async function sendRunPrompt(chat: QueuedMessageTestRig): Promise<void> {
  const fields = { body: agentSessionMessagePayload(body), delivery: 'queue-if-active' as const }
  const sent = await chat.host.send(QUEUED_RIG_CALLER, {
    envelope: chat.envelope(fields, 'agentSession.send', messageId),
    ...fields,
    body,
    userSend: true
  })
  expect(sent).toMatchObject({ ok: true })
}

/** Orca quit while the run's prompt waited for its agent to start. */
async function quitBeforeTheAgentGotIt(): Promise<QueuedMessageTestRig> {
  const chat = await createQueuedMessageTestRig({
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
  rig = chat
  chat.holdNextStart()
  await sendRunPrompt(chat)
  await chat.crashRestartHostFromDisk()
  setStructuredAgentSessionHost(chat.host)
  return chat
}

function runtimeOf(chat: QueuedMessageTestRig): OrcaRuntimeService {
  const orchestration = new OrchestrationDb(':memory:')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the runtime calls recovery makes
  return {
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => chat.store,
    getOrchestrationDb: () => orchestration,
    bots: { list: () => [] }
  } as unknown as OrcaRuntimeService
}

async function sendsOf(chat: QueuedMessageTestRig) {
  const journal = chat.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  return (await journal.reads.input({ kind: 'linked-to', messageId })).submissions
}

it('sends a run prompt kept at restart once, straight from a cold start', async () => {
  const chat = await quitBeforeTheAgentGotIt()
  const runtime = runtimeOf(chat)
  // Nothing has opened the chat since the restart: recovery's own reads must find and open it.
  expect(await placementOf(runtime, run)).toMatchObject({ kind: 'chat', sessionId: SESSION })
  expect(await placementOf(runtime, { id: 'run-2', createdAt: NOW })).toEqual({ kind: 'unsent' })
  await Promise.all([
    sendRunPromptKeptAtRestart(runtime, run),
    sendRunPromptKeptAtRestart(runtime, run)
  ])
  await sendRunPromptKeptAtRestart(runtime, run)
  expect(await chat.submission(messageId)).toMatchObject({ rejection: { kind: 'hostRestarted' } })
  expect(await sendsOf(chat)).toHaveLength(1)
  expect(await chat.drafts()).toEqual([])
})

it('never sends a kept prompt someone withdrew', async () => {
  const chat = await quitBeforeTheAgentGotIt()
  expect(await chat.drafts()).toEqual([expect.objectContaining({ messageId, state: 'waiting' })])
  expect(await chat.deleteQueued(messageId)).toMatchObject({ ok: true })
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run)
  expect(await sendsOf(chat)).toEqual([])
})

it('leaves a prompt queued behind a running turn to the queue, and still finds its chat', async () => {
  rig = await createQueuedMessageTestRig({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
  setStructuredAgentSessionHost(rig.host)
  await rig.workingSend()
  await sendRunPrompt(rig)
  const runtime = runtimeOf(rig)
  expect(await placementOf(runtime, run)).toMatchObject({ kind: 'chat', sessionId: SESSION })
  await sendRunPromptKeptAtRestart(runtime, run)
  expect(await rig.drafts()).toEqual([expect.objectContaining({ messageId, state: 'waiting' })])
  expect(await sendsOf(rig)).toEqual([])
})

// Builds before run-derived ids sent a run's prompt under a random id; only the run it carries says
// a chat took it, so the restart must never dispatch it a second time.
it("never reads an older build's send of the run as unsent", async () => {
  rig = await createQueuedMessageTestRig({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
  const automationRun = {
    runId: 'run-old',
    automation: {
      id: 'a1',
      name: 'Daily report',
      enabled: true,
      nextRunAt: 0,
      updatedAt: 0,
      rrule: 'FREQ=DAILY',
      dtstart: 0,
      workspaceId: null
    },
    trigger: 'scheduled' as const,
    instructionsLength: 0
  }
  const oldBody = { ...body, automationRun }
  const fields = { body: agentSessionMessagePayload(oldBody), delivery: 'queue-if-active' as const }
  expect(
    await rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.send', `${NOW}-${'0'.repeat(31)}9`),
      ...fields,
      body: oldBody,
      userSend: true
    })
  ).toMatchObject({ ok: true })
  await rig.crashRestartHostFromDisk()
  expect(await placementOf(runtimeOf(rig), { id: 'run-old', createdAt: NOW })).toEqual({
    kind: 'unconfirmed'
  })
})
