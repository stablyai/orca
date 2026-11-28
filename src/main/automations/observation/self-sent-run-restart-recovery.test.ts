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
import { selfSentRunReceipt, sendRunPromptKeptAtRestart } from './self-sent-run-restart-recovery'

// Orca quit while a self-sent run's prompt waited for its agent to start: after the restart, the run finds
// its chat by the prompt's id and sends the kept prompt exactly once, however often recovery runs.
let rig: QueuedMessageTestRig | null = null
const live = new AbortController().signal
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the runtime calls recovery makes
  return {
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => chat.store
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
  expect(await selfSentRunReceipt(runtime, run)).toMatchObject({ kind: 'chat', sessionId: SESSION })
  expect(await selfSentRunReceipt(runtime, { id: 'run-2', createdAt: NOW })).toBeNull()
  await Promise.all([
    sendRunPromptKeptAtRestart(runtime, run, live),
    sendRunPromptKeptAtRestart(runtime, run, live)
  ])
  await sendRunPromptKeptAtRestart(runtime, run, live)
  expect(await chat.submission(messageId)).toMatchObject({ rejection: { kind: 'hostRestarted' } })
  expect(await sendsOf(chat)).toHaveLength(1)
  expect(await chat.drafts()).toEqual([])
})

it('never sends a kept prompt once Orca is quitting', async () => {
  const chat = await quitBeforeTheAgentGotIt()
  const quitting = new AbortController()
  quitting.abort()
  await expect(sendRunPromptKeptAtRestart(runtimeOf(chat), run, quitting.signal)).rejects.toThrow()
  expect(await sendsOf(chat)).toEqual([])
})

it('leaves a prompt queued behind a running turn to the queue, and still finds its chat', async () => {
  rig = await createQueuedMessageTestRig({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
  setStructuredAgentSessionHost(rig.host)
  await rig.workingSend()
  await sendRunPrompt(rig)
  // Restarting holds it like a kept prompt, but the restart never cut a send of it.
  await restartAgain(rig)
  const runtime = runtimeOf(rig)
  expect(await selfSentRunReceipt(runtime, run)).toMatchObject({ kind: 'chat', sessionId: SESSION })
  await sendRunPromptKeptAtRestart(runtime, run, live)
  expect(await rig.drafts()).toEqual([expect.objectContaining({ messageId, state: 'waiting' })])
  expect(await sendsOf(rig)).toEqual([])
})

/** Restarts again, as Orca does after the person acted on the kept prompt. */
async function restartAgain(chat: QueuedMessageTestRig): Promise<void> {
  await chat.crashRestartHostFromDisk()
  setStructuredAgentSessionHost(chat.host)
}

it('never resends a kept prompt the person Stopped after recovery sent it', async () => {
  const chat = await quitBeforeTheAgentGotIt()
  chat.holdNextStart()
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run, live)
  expect(await chat.stop()).toMatchObject({ ok: true })
  await restartAgain(chat)
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run, live)
  expect(await sendsOf(chat)).toHaveLength(1)
})

it('never sends a kept prompt its agent refused', async () => {
  const chat = await quitBeforeTheAgentGotIt()
  chat.holdNextStart()
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run, live)
  await chat.settleRejected(await chat.handoffId(messageId), 'refused')
  expect(await chat.drafts()).toEqual([expect.objectContaining({ messageId, state: 'returned' })])
  await restartAgain(chat)
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run, live)
  expect(await sendsOf(chat)).toHaveLength(1)
})

it('never resends a kept prompt whose chat the person closed after recovery sent it', async () => {
  const chat = await quitBeforeTheAgentGotIt()
  chat.holdNextStart()
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run, live)
  await chat.host.close(SESSION, 'user-close')
  await restartAgain(chat)
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run, live)
  expect(await sendsOf(chat)).toHaveLength(1)
})

it('never sends a kept prompt while a Stop of a later turn holds the queue', async () => {
  const chat = await quitBeforeTheAgentGotIt()
  chat.holdNextStart()
  await chat.send('something else').result
  expect(await chat.stop()).toMatchObject({ ok: true })
  await sendRunPromptKeptAtRestart(runtimeOf(chat), run, live)
  expect(await sendsOf(chat)).toEqual([])
})
