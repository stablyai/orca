// Codex 0.158 asks with `request_user_input_async`: no server request, only an async
// `agentMessage` carrying `questions`, then `sleep` items until the user writes. Driven
// against the real host, journal and Codex adapter with frames captured from 0.158.0.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type {
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatus } from '../../shared/structured-agent-session-projection'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import {
  THREAD_ID as THREAD,
  adapterFor,
  fakeCodex
} from './codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from './codex-turn-lifecycle-fake'

const CALLER = { callerKey: 'client-1' }
const QUESTION = 'Which color do you prefer: red or blue?'

// Captured from `codex app-server` 0.158.0 in default mode.
const ASYNC_QUESTION_ITEM = {
  type: 'agentMessage',
  id: 'call_9dLvbBrpvbRlTP45pC6KXyYK',
  text: 'Which color do you prefer: red or blue?\n- Red\n- Blue',
  phase: 'final_answer',
  delivery: 'async',
  questions: [{ title: QUESTION, options: ['Red', 'Blue'] }]
}

let root: string
let host: StructuredAgentSessionHost
let codex: ReturnType<typeof fakeCodex>
let turns: ReturnType<typeof codexTurnLifecycleFake>
let notify: (method: string, params: unknown) => void

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-async-question-'))
  resetHostTestOperationIds()
  codex = fakeCodex()
  notify = (method, params) => codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  turns = codexTurnLifecycleFake(THREAD, () => notify)
  codex.routes['turn/start'] = turns.routes['turn/start']
  const store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapterFor(codex), { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
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

async function items(): Promise<AgentJournalRenderItem[]> {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items
}

async function questionRows(): Promise<
  (AgentJournalRenderItem & { body: AgentJournalQuestionItem })[]
> {
  return (await items()).flatMap((item) =>
    item.body.kind === 'question' ? [{ ...item, body: item.body }] : []
  )
}

/** Codex asks, then sleeps while it waits: the frames 0.158 sent, in order. */
async function askAsync(): Promise<void> {
  expect(await send('Ask me whether I prefer red or blue.')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
  turns.start()
  notify('item/completed', { threadId: THREAD, turnId: 'turn-1', item: ASYNC_QUESTION_ITEM })
  for (let index = 0; index < 4; index += 1) {
    notify('item/started', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: { type: 'sleep', id: `call_sleep_${index}`, durationMs: 30000 }
    })
  }
  await host.flushStreamedEvents(SESSION)
}

function answer(item: AgentJournalRenderItem & { body: AgentJournalQuestionItem }, label: string) {
  const option = item.body.options.find((candidate) => candidate.label === label)
  const fields = {
    itemId: item.itemId,
    expectedRevision: item.revision,
    optionId: option?.id ?? `missing:${label}`
  }
  return host.respondToPrompt(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.respondTo:question',
        sessionId: SESSION,
        fields
      })
    },
    kind: 'question',
    ...fields
  })
}

describe('a Codex async question (request_user_input_async)', () => {
  it('shows a pending question card and puts the session in attention', async () => {
    await askAsync()

    expect.soft(projectStructuredAgentSessionStatus(await items())).toBe('attention')
    const rows = await questionRows()
    expect(rows.map((row) => row.body.question)).toEqual([QUESTION])
    expect(rows[0]!.body.options.map((option) => option.label)).toEqual(['Red', 'Blue'])
    expect(rows[0]!.body.resolution.state).toBe('pending')
    // `sleep` is Codex waiting on the user, not a row.
    expect((await items()).filter((item) => JSON.stringify(item.body).includes('sleep'))).toEqual(
      []
    )
  })

  it('sends the chosen option as a steering user message, not a server-request reply', async () => {
    await askAsync()
    const [row] = await questionRows()

    expect(await answer(row!, 'Red')).toMatchObject({ ok: true })

    const steer = codex.connections[0]!.calls.findLast((call) => call.method === 'turn/start')
    expect(steer?.params).toMatchObject({
      threadId: THREAD,
      input: [{ type: 'text', text: 'Red' }]
    })
    expect(codex.connections[0]!.replies).toEqual([])
    const [resolved] = await questionRows()
    expect(resolved!.body.resolution.state).toBe('resolved')
    expect(projectStructuredAgentSessionStatus(await items())).toBe('working')
  })

  it('resolves the card with the typed reply when the user writes instead', async () => {
    await askAsync()

    expect(await send('Blue, definitely')).toMatchObject({ ok: true })
    const clientId = codex.connections[0]!.calls.findLast((call) => call.method === 'turn/start')
      ?.params?.clientUserMessageId
    notify('item/started', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'item-user-2',
        clientId,
        content: [{ type: 'text', text: 'Blue, definitely' }]
      }
    })

    const [row] = await questionRows()
    expect(row!.body.resolution).toMatchObject({
      state: 'resolved',
      answers: [expect.objectContaining({ other: 'Blue, definitely' })]
    })
    expect(projectStructuredAgentSessionStatus(await items())).toBe('working')
  })

  it('cancels the card when the turn ends unanswered', async () => {
    await askAsync()

    turns.end('interrupted')

    const [row] = await questionRows()
    expect(row!.body.resolution.state).toBe('cancelled')
    expect(projectStructuredAgentSessionStatus(await items())).not.toBe('attention')
  })

  it('steers one message naming each question once every card of a multi-question ask is answered', async () => {
    expect(await send('ask me two things')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
    turns.start()
    notify('item/completed', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: {
        ...ASYNC_QUESTION_ITEM,
        questions: [
          { title: 'Color?', options: ['Red', 'Blue'] },
          { title: 'Size?', options: ['Small', 'Large'] }
        ]
      }
    })
    const steers = () =>
      codex.connections[0]!.calls.filter((call) => call.method === 'turn/start').length

    const [color, size] = await questionRows()
    expect(await answer(color!, 'Blue')).toMatchObject({ ok: true })
    expect(steers()).toBe(1)
    expect(projectStructuredAgentSessionStatus(await items())).toBe('attention')
    expect(await answer(size!, 'Large')).toMatchObject({ ok: true })

    expect(
      codex.connections[0]!.calls.findLast((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ input: [{ type: 'text', text: 'Color?: Blue\nSize?: Large' }] })
    expect(steers()).toBe(2)
  })

  it('still delivers a card answer when a typed reply closes a partly answered ask', async () => {
    expect(await send('ask me two things')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
    turns.start()
    notify('item/completed', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: {
        ...ASYNC_QUESTION_ITEM,
        questions: [
          { title: 'Color?', options: ['Red', 'Blue'] },
          { title: 'Size?', options: ['Small', 'Large'] }
        ]
      }
    })
    const [color] = await questionRows()
    expect(await answer(color!, 'Blue')).toMatchObject({ ok: true })

    expect(await send('Large')).toMatchObject({ ok: true })
    const typed = () =>
      codex.connections[0]!.calls.find(
        (call) =>
          call.method === 'turn/start' &&
          JSON.stringify(call.params?.input) === JSON.stringify([{ type: 'text', text: 'Large' }])
      )
    await vi.waitFor(() => expect(typed()).toBeDefined())
    const clientId = typed()?.params?.clientUserMessageId
    notify('item/started', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'item-user-2',
        clientId,
        content: [{ type: 'text', text: 'Large' }]
      }
    })

    const inputs = codex.connections[0]!.calls.filter((call) => call.method === 'turn/start').map(
      (call) => call.params?.input
    )
    expect(inputs).toEqual([
      [{ type: 'text', text: 'ask me two things' }],
      [{ type: 'text', text: 'Large' }],
      [{ type: 'text', text: 'Color?: Blue' }]
    ])
  })

  async function answerColorOfTwo(): Promise<void> {
    expect(await send('ask me two things')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
    turns.start()
    notify('item/completed', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: {
        ...ASYNC_QUESTION_ITEM,
        questions: [
          { title: 'Color?', options: ['Red', 'Blue'] },
          { title: 'Size?', options: ['Small', 'Large'] }
        ]
      }
    })
    const [color] = await questionRows()
    expect(await answer(color!, 'Blue')).toMatchObject({ ok: true })
  }

  const turnStartInputs = () =>
    codex.connections[0]!.calls.filter((call) => call.method === 'turn/start').map(
      (call) => call.params?.input
    )

  it('still delivers a card answer when Codex ends the turn on a partly answered ask', async () => {
    await answerColorOfTwo()

    turns.end('completed')

    await vi.waitFor(() =>
      expect(turnStartInputs()).toEqual([
        [{ type: 'text', text: 'ask me two things' }],
        [{ type: 'text', text: 'Color?: Blue' }]
      ])
    )
    expect((await questionRows()).map((row) => row.body.resolution.state)).toEqual([
      'resolved',
      'cancelled'
    ])
  })

  it('does not restart work a Stop ended to deliver a partly answered ask', async () => {
    await answerColorOfTwo()

    turns.end('interrupted')
    await host.flushStreamedEvents(SESSION)

    expect(turnStartInputs()).toEqual([[{ type: 'text', text: 'ask me two things' }]])
  })

  it('keeps the blocking requestUserInput path for older Codex builds', async () => {
    expect(await send('ask me')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
    turns.start()
    codex.connections[0]!.handlers.onServerRequest?.({
      id: 41,
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'codex-item-1',
        threadId: THREAD,
        turnId: 'turn-1',
        questions: [{ id: 'color', question: QUESTION, options: [{ label: 'Red' }] }]
      }
    })
    const [row] = await questionRows()
    expect(projectStructuredAgentSessionStatus(await items())).toBe('attention')

    expect(await answer(row!, 'Red')).toMatchObject({ ok: true })

    expect(codex.connections[0]!.replies).toEqual([
      { id: 41, result: { answers: { color: { answers: ['Red'] } } } }
    ])
    expect(codex.connections[0]!.calls.filter((call) => call.method === 'turn/start')).toHaveLength(
      1
    )
  })
})
