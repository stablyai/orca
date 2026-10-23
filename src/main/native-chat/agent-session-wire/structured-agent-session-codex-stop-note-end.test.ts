import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
// What a Stop's row says when Codex took the interrupt, against the real host, journal and Codex
// adapter. Codex answers a turn's interrupt as the turn aborts and sends the turn's end right after
// the answer, so the end reaches Orca a moment after the Stop has its answer.

import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import {
  THREAD_ID as THREAD,
  adapterFor,
  acquireReadyCodexForTest,
  identityFor,
  fakeCodex
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  recordingStructuredAgentSessionLogger,
  testEventSinkLogging
} from './structured-agent-session-logger-test-support'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }

let events: AgentSessionSubscribeEvent[]
let unconfirmedNote: AgentJournalRenderItem | undefined
let root: string
let store: Awaited<ReturnType<typeof openTestAgentSessionRecordStore>>
let host: StructuredAgentSessionHost
let turns: ReturnType<typeof codexTurnLifecycleFake>
let codex: ReturnType<typeof fakeCodex>
let notify: (method: string, params: unknown) => void
/** Read at each start, so a test can say what the next start resumes. */
let launch: { resumeThreadId?: string | null }
let adapter: CodexStructuredSessionAdapter

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-stop-row-'))
  resetHostTestOperationIds()
  events = []
  unconfirmedNote = undefined
  codex = fakeCodex()
  notify = (method, params) => codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  turns = codexTurnLifecycleFake(THREAD, () => notify)
  codex.routes['turn/start'] = turns.routes['turn/start']
  codex.routes['turn/interrupt'] = () => {
    const turnId = turns.turnId
    // The answer first, then the turn's end on a later read of Codex's output.
    setTimeout(
      () =>
        notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'interrupted' } }),
      4
    )
    return {}
  }
  store = await openTestAgentSessionRecordStore(root)
  // The runtime's wiring: an echo accepts its send, and every exit reaches the host.
  launch = {}
  adapter = adapterFor(codex, launch, [], {
    onDispatchSettledLate: (settlement) => host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'options-reported' || (event.type === 'ended' && 'cause' in event)) {
        void host.handleAdapterEvent(event)
      }
    }
  })
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: recordingStructuredAgentSessionLogger().logger,
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  await host.subscribe({
    id: 'stop-note-live',
    sessionId: SESSION,
    emit: (event) => events.push(event)
  })
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function send(text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
}

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
}

async function runningTurn(): Promise<void> {
  const sent = await send('count to 40')
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
  turns.start()
  turns.echo(sent.value.clientMessageId)
  await vi.waitFor(async () =>
    expect((await notesAndTurn()).turn?.body).toMatchObject({ state: 'running' })
  )
}

async function notesAndTurn() {
  await host.flushStreamedEvents(SESSION)
  const items = (await host.journalSnapshot(SESSION)).items
  return {
    notes: items.filter((item) => isStructuredAgentSessionStopNote(item.itemId)),
    turn: items.find((item) => item.body.kind === 'turn')
  }
}

async function unconfirmedStop() {
  await runningTurn()
  codex.routes['turn/interrupt'] = () => {
    throw new CodexAppServerTimeoutError('codex app-server turn/interrupt exceeded 30000ms')
  }
  const connection = codex.connections[0]!
  const close = connection.close
  connection.close = async () => {
    connection.close = close
    connection.closeCount += 1
    return false
  }
  await expect(stop()).resolves.toMatchObject({ ok: true })
  const { notes, turn } = await notesAndTurn()
  expect(notes).toHaveLength(1)
  expect(notes[0]?.body).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
  expect(turn?.body).toMatchObject({ state: 'running' })
  unconfirmedNote = notes[0]
  return connection
}

async function confirmedNote(): Promise<void> {
  await vi.waitFor(async () => {
    const { notes, turn } = await notesAndTurn()
    expect(turn?.body).toMatchObject({ state: 'interrupted' })
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toEqual({ kind: 'status', text: 'Cancellation requested.' })
    expect(notes[0]?.turnScope).toEqual({ kind: 'turn', turnItemId: turn?.itemId })
    expect(notes[0]).toMatchObject({
      itemId: unconfirmedNote?.itemId,
      revision: unconfirmedNote?.revision,
      sequence: unconfirmedNote?.sequence
    })
    const journal = host['sessions'].get(SESSION)!.journal
    expect(journal.itemBody(notes[0]!.itemId)).toMatchObject({
      failure: { kind: 'cancelUnconfirmed' }
    })
    expect(
      events.some(
        (event) =>
          event.type === 'batch' &&
          event.batch.items.some(
            (item) =>
              item.itemId === notes[0]?.itemId &&
              item.body.kind === 'status' &&
              item.body.text === 'Cancellation requested.' &&
              !item.body.failure
          ) &&
          event.batch.items.some(
            (item) =>
              item.itemId === turn?.itemId &&
              item.body.kind === 'turn' &&
              item.body.state === 'interrupted'
          )
      )
    ).toBe(true)
  })
}

it('projects the note on a late self-exit after the kill timed out', async () => {
  const connection = await unconfirmedStop()
  connection.handlers.onExit?.(new Error('codex exited'), { expected: true })
  await confirmedNote()
})

it('projects the note when a second Stop joins the close and proves the exit', async () => {
  await unconfirmedStop()
  await expect(stop()).resolves.toMatchObject({ ok: true })
  await confirmedNote()
})

it('projects the note when a send joins the close and proves the exit', async () => {
  const connection = await unconfirmedStop()
  await expect(send('Carry on.')).resolves.toMatchObject({ ok: true })
  await vi.waitFor(() => {
    expect(codex.connections.at(-1)).not.toBe(connection)
    expect(connection.closeCount).toBe(2)
  })
  await confirmedNote()
})

it("projects the note when Codex's own interrupted result ends the turn", async () => {
  await unconfirmedStop()
  turns.end('interrupted')
  await confirmedNote()
})

it('keeps the note unconfirmed when the turn completes', async () => {
  await unconfirmedStop()
  turns.end('completed')
  await vi.waitFor(async () => {
    const { notes, turn } = await notesAndTurn()
    expect(turn?.body).toMatchObject({ state: 'completed' })
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
  })
})

it('isolates legacy acquired history from live matching and saves exact proof before optional overflow', async () => {
  const journal = () => host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const body = hostTestMessage('same input')
  for (const id of ['U', 'K', 'V']) {
    await journal().appendSubmission({
      clientMessageId: id,
      body,
      payloadFingerprint: id,
      fence: 1,
      origin: 'client',
      handoverRecorded: true
    })
    await journal().resolveDispatch({ clientMessageId: id, state: 'unknown', fence: 1 })
  }
  await journal().replaceEpochItems('handle_forked', store.getRecord(SESSION)!.lease.runtimeFence, [
    { identity: { provider: 'orca', clientMessageId: 'U' }, body }
  ])
  expect(journal().item('orca:U')?.revision).toBeGreaterThan(1)
  const user = (id: string | null) => ({
    type: 'userMessage',
    id: 'old-user',
    clientId: id,
    content: [{ type: 'text', text: 'same input', text_elements: [] }]
  })
  const oldTurn = (items: unknown[]) => ({ id: 'legacy-turn', status: 'completed', items })
  const pages = vi.fn(() => {
    throw new Error('old provider has no pagination')
  })
  codex.routes['thread/turns/list'] = pages
  const reopen = async (returned: unknown[]) => {
    await host.close(SESSION, 'evict')
    launch.resumeThreadId = THREAD
    codex.routes['thread/resume'] = () => ({ thread: { id: THREAD, turns: returned } })
    await host.journalSnapshot(SESSION)
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({
      journal: journal(),
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      publish: () => {}
    })
    const resumed = adapterFor(codex, { resumeThreadId: THREAD }, [], {
      onDispatchSettledLate: (settlement) => host.settleLateDispatch(settlement)
    })
    try {
      await acquireReadyCodexForTest(resumed, {
        identity: identityFor(SESSION),
        fence: store.getRecord(SESSION)!.lease.runtimeFence,
        spawnToken: 'recorded-fixture-child',
        events: deferred.sink
      })
      await deferred.drained()
    } finally {
      deferred.close()
      await resumed.closeAll()
    }
  }
  await reopen([
    oldTurn([user(null), { type: 'agentMessage', id: 'old-answer', text: 'historical answer' }])
  ])
  expect(journal().submission('U')?.dispatchState).toBe('unknown')
  expect(journal().receiptFor('U')).toBeNull()
  const before = journal().cursor()
  await reopen([
    oldTurn([user(null), { type: 'agentMessage', id: 'old-answer', text: 'historical answer' }])
  ])
  expect(journal().cursor()).toEqual(before)
  await journal().replaceEpochItems(
    'handle_forked',
    store.getRecord(SESSION)!.lease.runtimeFence,
    []
  )
  await reopen([
    oldTurn([
      user('U'),
      { type: 'agentMessage', id: 'previously-unseen', text: 'must stay hidden' }
    ])
  ])
  expect(journal().submission('U')?.dispatchState).toBe('accepted')
  expect(journal().snapshot().items).toEqual([])
  await reopen([
    {
      id: 'huge',
      status: 'completed',
      items: [
        user('K'),
        ...Array.from({ length: 1_100 }, (_, n) => ({
          type: 'agentMessage',
          id: `large-${n}`,
          text: 'outside answer'
        }))
      ]
    }
  ])
  expect(journal().submission('K')?.dispatchState).toBe('accepted')
  expect(journal().snapshot().items).toEqual([])
  expect(journal().submission('V')?.dispatchState).toBe('unknown')
  expect(pages).not.toHaveBeenCalled()
  await reopen([])
  expect(journal().receiptFor('K')).not.toBeNull()
  expect(journal().submission('V')?.dispatchState).toBe('unknown')
})
