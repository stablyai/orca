// A follow-up Claude queued behind the running turn is dropped by Stop, so the chat must record it
// as withdrawn and stop reading as working — under the SessionStart hook Orca installs, whose frame
// proves the start before the turn's system/init says the CLI can cancel its queue.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
// As Claude Code 2.1.280 advertises them on a turn's system/init frame.
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let queued: string[]
let claude: ReturnType<typeof fakeClaude>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-queued-stop-'))
  resetHostTestOperationIds()
  queued = []
  claude = fakeClaude({
    replayUuid: null,
    initProof: 'session-start',
    // What the real CLI answers: cancel_queued cancels the queue, a plain interrupt keeps it.
    routes: {
      interrupt: (params) =>
        params?.cancelQueued
          ? { still_queued: [], cancelled: queued.splice(0) }
          : { still_queued: [...queued] }
    }
  })
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    // As the runtime wires it.
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await adapter.awaitStarted(SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually(assertion: () => unknown): Promise<unknown> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel' | 'agentSession.queuedMessageSend',
  fields: Record<string, unknown>
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  return sent.value.clientMessageId
}

async function dispatch(clientMessageId: string) {
  const submission = (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
  return { state: submission?.dispatchState, reason: submission?.reason }
}

async function status(): Promise<string> {
  const snapshot = await host.journalSnapshot(SESSION)
  return projectStructuredAgentSessionStatus(
    snapshot.items,
    snapshot.submissions,
    store.getRecord(SESSION)!.lease.runtimeFence
  )
}

async function liveTurnId(): Promise<string | null> {
  return activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
}

/** Sends the first message and lets Claude open its turn; returns the turn a client reads. */
async function openFirstTurn(connection: (typeof claude.connections)[number]): Promise<string> {
  const first = await send('Write a long reply.')
  await eventually(() => expect(connection.sent).toHaveLength(1))
  // Claude opens the turn: its system/init, then the echo of the message it runs.
  connection.handlers.onMessage?.({
    type: 'system',
    subtype: 'init',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'turn-init',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  connection.handlers.onMessage?.({
    ...connection.sent.at(-1)!,
    uuid: connection.sent.at(-1)!.uuid
  })
  await eventually(async () => expect((await dispatch(first)).state).toBe('accepted'))
  const turnId = await liveTurnId()
  expect(turnId).not.toBeNull()
  return turnId!
}

async function endFirstTurn(connection: (typeof claude.connections)[number]): Promise<void> {
  connection.handlers.onMessage?.({
    type: 'result',
    subtype: 'success',
    uuid: 'result-first',
    session_id: PROVIDER_SESSION_ID,
    is_error: false,
    terminal_reason: 'completed',
    duration_ms: 12
  })
  await eventually(async () => expect(await liveTurnId()).toBeNull())
}

function stop(turnId: string) {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', { turnId }), turnId })
}

it('withdraws a follow-up Claude queued behind the running turn when that turn is stopped', async () => {
  const connection = claude.connections[0]!
  const turnId = await openFirstTurn(connection)

  const followUp = await send('And then this.')
  await eventually(() => expect(connection.sent).toHaveLength(2))
  queued.push(String(connection.sent.at(-1)!.uuid))
  await eventually(async () => expect((await dispatch(followUp)).state).toBe('pending'))

  const stopped = await stop(turnId)
  expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  // The interrupted turn closes as the CLI ends it.
  connection.handlers.onMessage?.({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'interrupted-result'
  })
  await eventually(async () =>
    expect(await dispatch(followUp)).toEqual({
      state: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
  )
  await eventually(async () => expect(await status()).toBe('idle'))
}, 15_000)

// The phone names the turn from its own copy of the journal, which can trail the host's.
it('withdraws a follow-up Claude holds when the turn the Stop names ended before it landed', async () => {
  const connection = claude.connections[0]!
  const turnId = await openFirstTurn(connection)
  const followUp = await send('And then this.')
  await eventually(() => expect(connection.sent).toHaveLength(2))
  queued.push(String(connection.sent.at(-1)!.uuid))
  await eventually(async () => expect((await dispatch(followUp)).state).toBe('pending'))
  await endFirstTurn(connection)

  expect(await stop(turnId)).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(connection.calls.find((call) => call.subtype === 'interrupt')?.params).toEqual({
    cancelQueued: true
  })
  await eventually(async () =>
    expect(await dispatch(followUp)).toEqual({
      state: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
  )
  await eventually(async () => expect(await status()).toBe('idle'))
}, 15_000)

it('withdraws a follow-up still queued on the host when the turn the Stop names already ended', async () => {
  const connection = claude.connections[0]!
  const turnId = await openFirstTurn(connection)
  await endFirstTurn(connection)
  // Holds the delivery loop between its start check and the handover, with the follow-up queued.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const awaitStarted = vi.spyOn(adapter, 'awaitStarted').mockImplementationOnce(async () => {
    await held
  })
  const followUp = await send('And then this.')
  await eventually(() => expect(awaitStarted).toHaveBeenCalled())
  const submission = (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === followUp
  )
  expect(submission && isQueuedAgentJournalSubmission(submission)).toBe(true)

  // Nothing reached Claude, so the host's withdrawal is the whole Stop, as with no turn named.
  expect(await stop(turnId)).toMatchObject({ ok: true, value: { cancelled: true } })
  release()
  await eventually(async () =>
    expect(await dispatch(followUp)).toEqual({
      state: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
  )
  expect(connection.sent).toHaveLength(1)
  await eventually(async () => expect(await status()).toBe('idle'))
  const rows = (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
  expect(rows).not.toContain('The provider had already finished this turn.')
}, 15_000)

it('withdraws a host-queued follow-up but leaves a newer turn running when the Stop names an older one', async () => {
  const connection = claude.connections[0]!
  const olderTurnId = await openFirstTurn(connection)
  await endFirstTurn(connection)
  const second = await send('Now this.')
  await eventually(() => expect(connection.sent).toHaveLength(2))
  connection.handlers.onMessage?.({
    ...connection.sent.at(-1)!,
    uuid: connection.sent.at(-1)!.uuid
  })
  await eventually(async () => expect((await dispatch(second)).state).toBe('accepted'))
  const newerTurnId = await liveTurnId()
  expect(newerTurnId).not.toBeNull()
  expect(newerTurnId).not.toBe(olderTurnId)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const awaitStarted = vi.spyOn(adapter, 'awaitStarted').mockImplementationOnce(async () => {
    await held
  })
  const followUp = await send('And then this.')
  await eventually(() => expect(awaitStarted).toHaveBeenCalled())

  expect(await stop(olderTurnId)).toMatchObject({ ok: true, value: { cancelled: false } })
  release()
  await eventually(async () =>
    expect(await dispatch(followUp)).toEqual({
      state: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
  )
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(await liveTurnId()).toBe(newerTurnId)
  const rows = (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
  expect(rows).not.toContain('The provider had already finished this turn.')
}, 15_000)

it('a card sent now into the running turn comes back paused when Stop withdraws it, and is not sent again', async () => {
  const connection = claude.connections[0]!
  const turnId = await openFirstTurn(connection)
  const body = hostTestMessage('And then this.')
  const delivery = 'queue-if-active' as const
  const queuedSend = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body, delivery }),
    body,
    delivery,
    userSend: true
  })
  if (!queuedSend.ok || !('queued' in queuedSend.value)) {
    throw new Error('expected a queued receipt')
  }
  const cardId = queuedSend.value.queued.messageId
  const sentNow = await host.queuedMessageSend(CALLER, {
    envelope: envelope('agentSession.queuedMessageSend', { messageId: cardId }),
    messageId: cardId
  })
  expect(sentNow).toMatchObject({ ok: true })
  // Folded into the running turn: Claude holds it until that turn ends.
  await eventually(() => expect(connection.sent).toHaveLength(2))
  queued.push(String(connection.sent.at(-1)!.uuid))
  const sends = async () =>
    (await host.journalSnapshot(SESSION)).submissions
      .filter((entry) => entry.queuedMessageId === cardId)
      .map((entry) => ({ origin: entry.origin, state: entry.dispatchState, reason: entry.reason }))
  await eventually(async () => expect((await sends())[0]?.state).toBe('pending'))

  expect(await stop(turnId)).toMatchObject({ ok: true, value: { cancelled: true } })
  connection.handlers.onMessage?.({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'interrupted-result'
  })

  // Inside the test's budget, so a re-send fails on this diff rather than the timeout.
  await vi.waitFor(async () => {
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect({
      pause: page.ok ? (page.page.queuePause ?? null) : 'history refused',
      cards: page.ok ? (page.page.queuedMessages ?? []).map((card) => card.state) : [],
      sends: await sends()
    }).toEqual({
      pause: { reason: 'stopped' },
      cards: ['waiting'],
      sends: [{ origin: 'client', state: 'rejected', reason: DISPATCH_REJECTED_CANCELLED }]
    })
  }, 5_000)
  // A drain ignoring the pause re-sends only after the stopped turn ends: watch past that.
  await eventually(async () => expect(await liveTurnId()).toBeNull())
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  expect(connection.sent).toHaveLength(2)
  expect(await sends()).toEqual([
    { origin: 'client', state: 'rejected', reason: DISPATCH_REJECTED_CANCELLED }
  ])
}, 20_000)
