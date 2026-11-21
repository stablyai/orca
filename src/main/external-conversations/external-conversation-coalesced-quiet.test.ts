import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorTurnEvents } from '../connector-cloud/connector-turn-events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionTurnCompletion } from '../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { codexJournalItem } from '../codex/structured/items/codex-structured-item-translation'
import type { CodexThreadItem } from '../codex/structured/items/codex-thread-item-identity'
import { CodexJournalTurnScopes } from '../codex/structured/journal/codex-journal-turn-scopes'
import {
  codexTurnLifecycleState,
  codexTurnOutcome,
  publishCodexTurnLifecycle
} from '../codex/structured/journal/codex-structured-journal-translation-turns'
import type { ExternalConversationBot } from '../../shared/connectors/external-conversation-link'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { chatPaneKey, type ConversationChatHost } from './external-conversation-chat'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'
import { HOST_CLOCK, type ExternalConversationHost } from './external-conversation-host'
import { harness, installedChats } from './external-conversation-seam.test-fixture'
import { WORKTREE } from './external-conversation.test-fixture'
import { StructuredAgentSessionJournalProjections } from '../native-chat/agent-session-wire/observations/structured-agent-session-status-journal-projection'
import type { ConversationKey } from './external-conversation-types'

// Reproduction: worker status at 16:25:51 holds the answer's completion until NO_REPLY at 16:25:54.
const KEY: ConversationKey = { source: 'slack', externalId: 'T1:C9:1795167481.858319' }
const THREAD_BOT: ExternalConversationBot = { kind: 'bot', botId: 'b1' }
const ANSWER = 'Delta scan: 3 new PRs since the last scan.'

const WORKER_STATUS: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'dispatch:d1', terminalHandle: null, orcaSessionId: null },
      name: 'Worker',
      relation: 'worker'
    }
  ],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'run:r1',
    dispatchId: null,
    messages: [{ messageId: 'm1', runId: 'r1', from: 'dispatch:d1' }]
  }
}

function linkedBot(chats: ConversationChatHost, extra: Parameters<typeof harness>[2] = {}) {
  const key = KEY
  const h = harness(undefined, undefined, extra)
  const host: ExternalConversationHost = { chat: chats }
  h.seam.linkChat(key, {
    worktreeId: WORKTREE,
    sessionId: HOST_TEST_SESSION,
    agent: 'codex',
    bot: THREAD_BOT
  })
  const paneKey = chatPaneKey(HOST_TEST_SESSION)
  h.hookRows.set(paneKey, {
    paneKey,
    agentType: 'codex',
    state: 'working',
    structuredHost: 'owned',
    connectionId: null,
    receivedAt: 400,
    stateStartedAt: 400,
    prompt: ''
  })
  const events: (ConversationEvent | ConversationSnapshot)[] = []
  h.seam.watch(host, (event) => events.push(event))
  return { ...h, host, key, events }
}

/** How the provider takes a send: as Claude mid-turn (admitted, owed until a turn of its own names
 *  it), or as Codex steering it into a running turn (accepted, its receipt naming that turn). */
type Taken = { owed: true } | { steeredInto: string } | null

/** The send `send` makes, as its row key. */
async function dispatched(send: () => Promise<unknown>, taken: Taken): Promise<string> {
  const { dispatch } = hostTestState()
  const sent = dispatch.mock.calls.length
  if (taken && 'owed' in taken) {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
  } else if (taken) {
    const turn = { provider: 'codex' as const, threadId: HOST_TEST_THREAD, ordinal: 7 }
    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { ...turn, turnId: taken.steeredInto }
    })
  }
  await send()
  await eventually(() => expect(dispatch.mock.calls.length).toBeGreaterThan(sent))
  return agentJournalSubmissionKey(dispatch.mock.calls[sent]?.[0].clientMessageId ?? '')
}

let deliveries = 0
let outboxPath: string

/** A message from the linked thread; `reply` when the cloud takes its answer through the outbox. */
function askFromThread(
  linked: ReturnType<typeof linkedBot>,
  input: { reply?: boolean; taken?: Taken } = {}
): Promise<string> {
  const bots = { refusal: () => null, open: vi.fn(), workLinks: async () => [] }
  return dispatched(async () => {
    const clock = vi.spyOn(HOST_CLOCK, 'now').mockReturnValue(400)
    await linked.seam.send({ bots, ...linked.host }, linked.key, `d${(deliveries += 1)}`, {
      text: 'do a prod release scan for the new delta PRs',
      ...(input.reply ? { reply: { account: 'account-a' } } : {})
    })
    clock.mockRestore()
  }, input.taken ?? null)
}

/** Orca sends a worker's mail into the bot's chat, which owes it a turn until one names it. */
function sendMail(): Promise<string> {
  const { host } = hostTestState()
  const words = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'Worker status: still running' }]
  }
  // Its sender rides as `from`, which no fingerprint covers.
  const body = { ...words, from: WORKER_STATUS }
  const sendEnvelope = envelope('agentSession.send', { body: words })
  return dispatched(
    async () => {
      expect(await host.send(CALLER, { envelope: sendEnvelope, body })).toMatchObject({ ok: true })
    },
    { owed: true }
  )
}

/** The provider (Codex) runs one turn for the sent row and says `words` in order, its turn row
 *  written and its rows scoped as the live adapter writes them; `running` happens while it runs. A
 *  Codex `status` gives the turn's verdict. */
async function providerTurn(
  turnId: string,
  sentItemId: string,
  words: string[],
  input: {
    running?: () => Promise<unknown>
    status?: 'completed' | 'interrupted'
    messages?: CodexThreadItem[]
  } = {}
): Promise<void> {
  const { host, acquire } = hostTestState()
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('the chat has no provider')
  }
  const thread = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  // The provider echoes the message it takes, and the turn names the echo.
  const journal = (
    await (await host.journalReads(HOST_TEST_SESSION)).operationWindow({ afterSequence: 0 })
  ).snapshot
  const sent = journal.items.find((item) => item.itemId === sentItemId)
  const echo = { provider: 'claude' as const, sessionId: 'claude-session', uuid: turnId }
  if (sent) {
    events.appendItem(echo, sent.body, thread)
  }
  const lifecycle = {
    sink: events,
    primaryThreadId: HOST_TEST_THREAD,
    sessionId: HOST_TEST_SESSION,
    threadId: HOST_TEST_THREAD,
    turnId,
    userItemId: sent ? agentJournalItemKey(echo) : sentItemId
  }
  publishCodexTurnLifecycle({ ...lifecycle, state: 'running' })
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  await input.running?.()
  const scopes = new CodexJournalTurnScopes({
    sessionId: HOST_TEST_SESSION,
    primaryThreadId: () => HOST_TEST_THREAD,
    activeTurn: () => turnId,
    commandScope: () => null
  })
  const turnScope = scopes.scopeFor(HOST_TEST_THREAD, turnId)
  const messages =
    input.messages ??
    words.map((text, index) => ({
      type: 'agentMessage',
      id: `message-${index}`,
      text,
      phase: 'final_answer'
    }))
  messages.forEach((message, index) => {
    const body = codexJournalItem(message).body
    if (body) {
      events.appendItem(
        { provider: 'codex', threadId: HOST_TEST_THREAD, turnId, ordinal: 10 + index },
        body,
        { turnScope }
      )
    }
  })
  const status = input.status ?? 'completed'
  const outcome = codexTurnOutcome(status)
  publishCodexTurnLifecycle({
    ...lifecycle,
    state: codexTurnLifecycleState(status),
    ...(outcome ? { outcome } : {})
  })
  await host.flushStreamedEvents(HOST_TEST_SESSION)
}

/** Holds status publications' reads until released, as a busy host does when the next turn starts
 *  first; other reads run so the host can still take sends. */
function holdStatusReads(): () => void {
  const read = StructuredAgentSessionJournalProjections.prototype.readSql
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  vi.spyOn(StructuredAgentSessionJournalProjections.prototype, 'readSql').mockImplementation(
    async function (this: StructuredAgentSessionJournalProjections, ...args) {
      if (args[3]) {
        await released
      }
      return read.apply(this, args)
    }
  )
  return release
}

const ended = (events: (ConversationEvent | ConversationSnapshot)[]) =>
  events.filter(
    (event): event is Extract<ConversationEvent, { kind: 'turn-ended' }> =>
      event.kind === 'turn-ended'
  )

async function botChat() {
  const { host } = hostTestState()
  await attach()
  const completions: AgentSessionTurnCompletion[] = []
  host.subscribeTurnCompletions({
    id: 'test-completions',
    emit: (event) => void (event.type === 'completion' && completions.push(event.completion))
  })
  return { chats: installedChats(host).chats, completions }
}

beforeEach(() => {
  outboxPath = mkdtempSync(join(tmpdir(), 'orca-coalesced-quiet-'))
  vi.useFakeTimers({ toFake: ['Date'], now: HOST_TEST_NOW })
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(async () => {
  await ConnectorTurnEvents.settled()
  rmSync(outboxPath, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function coalescedReply(earlier = ANSWER) {
  const { chats, completions } = await botChat()
  const linked = linkedBot(chats)
  const asked = await askFromThread(linked)
  let mail = ''
  await providerTurn('turn-a', asked, [earlier], {
    running: async () => {
      vi.setSystemTime(Date.parse('2026-11-20T16:25:51Z'))
      mail = await sendMail()
    }
  })
  vi.setSystemTime(Date.parse('2026-11-20T16:25:54Z'))
  await providerTurn('turn-b', mail, ['NO_REPLY'])
  await eventually(() => expect(ended(linked.events)).toHaveLength(1))
  return { linked, completions, events: ended(linked.events) }
}

it('posts one constant fallback for the 16:25:51 / 16:25:54 coalesced quiet completion', async () => {
  const result = await coalescedReply()
  expect(result.completions).toMatchObject([{ turnId: 'turn-b', mergedTurnCount: 2 }])
  expect(result.events).toMatchObject([
    {
      origin: 'delivery',
      lastAssistantMessage: 'I replied but the message may not have reached you. Please ask again.'
    }
  ])
})

it('merges a held answer whose end no status read saw before the next turn started', async () => {
  const { chats, completions } = await botChat()
  const linked = linkedBot(chats)
  const asked = await askFromThread(linked)
  let mail = ''
  let release = () => {}
  await providerTurn('turn-a', asked, [ANSWER], {
    running: async () => {
      mail = await sendMail()
      release = holdStatusReads()
    }
  })
  await providerTurn('turn-b', mail, ['NO_REPLY'], { running: async () => release() })
  await eventually(() => expect(ended(linked.events)).toHaveLength(1))
  expect(completions).toMatchObject([{ turnId: 'turn-b', mergedTurnCount: 2 }])
  expect(ended(linked.events)[0]?.lastAssistantMessage).toBe(
    'I replied but the message may not have reached you. Please ask again.'
  )
})

it('posts the fallback when the dropped answer sits behind more held turns than the scan reads', async () => {
  const { chats } = await botChat()
  const linked = linkedBot(chats)
  let sent = await askFromThread(linked)
  for (let turn = 0; turn < 10; turn += 1) {
    let mail = ''
    await providerTurn(`turn-${turn}`, sent, [turn === 0 ? ANSWER : 'NO_REPLY'], {
      running: async () => {
        mail = await sendMail()
      }
    })
    sent = mail
  }
  await providerTurn('last', sent, ['NO_REPLY'])
  await eventually(() => expect(ended(linked.events)).toHaveLength(1))
  expect(ended(linked.events)[0]?.lastAssistantMessage).toBe(
    'I replied but the message may not have reached you. Please ask again.'
  )
})

const quietLogs = () =>
  vi
    .mocked(console.info)
    .mock.calls.filter(([message]) => message === '[connector] merged quiet completion')

it('keeps a single-turn NO_REPLY silent and logs only the merged decision, without ids or text', async () => {
  const { linked, events } = await coalescedReply()
  expect(events[0]?.lastAssistantMessage).toBe(
    'I replied but the message may not have reached you. Please ask again.'
  )
  expect(quietLogs()).toEqual([
    [
      '[connector] merged quiet completion',
      { providerTurnCount: 2, fallback: true, reason: 'coalesced-quiet' }
    ]
  ])
  const asked = await askFromThread(linked)
  await providerTurn('single', asked, ['NO_REPLY'])
  await eventually(() => expect(ended(linked.events)).toHaveLength(2))
  expect(ended(linked.events)[1]).not.toHaveProperty('lastAssistantMessage')
  expect(quietLogs()).toHaveLength(1)
})

it('stays silent when the thread message itself got the quiet answer after merged mail', async () => {
  const { chats, completions } = await botChat()
  const linked = linkedBot(chats)
  const asked = await askFromThread(linked)
  let mail = ''
  await providerTurn('turn-a', asked, ['NO_REPLY'], {
    running: async () => {
      mail = await sendMail()
    }
  })
  let again = ''
  await providerTurn('turn-b', mail, ['Private note for the worker'], {
    running: async () => {
      again = await askFromThread(linked, { taken: { owed: true } })
    }
  })
  await providerTurn('turn-c', again, ['NO_REPLY'])
  await eventually(() => expect(completions).toHaveLength(1))
  await eventually(() => expect(ended(linked.events)).toHaveLength(1))
  expect(ended(linked.events)[0]).not.toHaveProperty('lastAssistantMessage')
  expect(completions).toMatchObject([{ turnId: 'turn-c', mergedTurnCount: 2 }])
  expect(quietLogs()).toEqual([
    [
      '[connector] merged quiet completion',
      { providerTurnCount: 2, fallback: false, reason: 'thread-answered-quietly' }
    ]
  ])
})

it('keeps the same fallback and outbox idempotency key when delivery is retried', async () => {
  const { events } = await coalescedReply()
  const outbox = new ConnectorTurnEvents(outboxPath, 'test-account')
  for (const event of events) {
    outbox.observe(event)
  }
  const first = outbox.next(7)
  const retry = outbox.next(7)
  expect(first).toMatchObject({
    stamp: { helloRev: 7, seq: 0, size: 1 },
    batch: [
      {
        lastAssistantMessage:
          'I replied but the message may not have reached you. Please ask again.'
      }
    ]
  })
  expect(retry).toEqual(first)
  if (!retry) {
    throw new Error('missing queued fallback')
  }
  outbox.accepted(retry.stamp)
  expect(outbox.next(7)).toBeNull()
})

it('outputs only the constant fallback, without earlier answer or private text', async () => {
  const { events } = await coalescedReply('Synthetic private answer that must never be recovered.')
  expect(events.map((event) => event.lastAssistantMessage)).toEqual([
    'I replied but the message may not have reached you. Please ask again.'
  ])
})
