// A Codex ask with several questions, driven from the real host journal through
// the client's session reducer to the rows the transcript list draws.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../shared/structured-agent-session-reducer'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from '../../shared/native-chat-transcript-projection'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { CodexJournalPrompts } from './codex-structured-journal-prompts'
import { CODEX_USER_INPUT_METHOD } from './codex-structured-prompt-replies'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  projectStructuredQuestionMessages,
  structuredQuestionTranscript
} from '../../renderer/src/components/native-chat/structured-agent-question-projection'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const CALLER = { callerKey: 'client-1' }

type Asked = readonly { id: string; question: string }[]

// Codex's question ids are the model's own words, so their text order is not
// the order it asked in. These two asks spell the two orders live QA saw.
const ASKED: Asked = [
  { id: 'scope', question: 'Which files are in scope?' },
  { id: 'priority', question: 'What matters most?' },
  { id: 'deadline', question: 'When is it due?' }
]
const ASKED_OUT_OF_ORDER: Asked = [
  { id: 'format', question: 'Which format?' },
  { id: 'audience', question: 'Who reads it?' },
  { id: 'length', question: 'How long?' }
]

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink | null
let client: StructuredAgentSessionState
let clock: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-question-order-'))
  resetHostTestOperationIds()
  sink = null
  clock = HOST_TEST_NOW
  const adapter: StructuredAgentSessionAdapter = {
    acquire: vi.fn<StructuredAgentSessionAdapter['acquire']>(async ({ fence, events }) => {
      sink = events ?? null
      return {
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: HOST_TEST_NOW
        }
      }
    }),
    releaseAcquisition: vi.fn(async () => true),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async ({ commit }) => commit()),
    setOption: vi.fn(async () => undefined)
  }
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    // Every write lands on its own millisecond, as it does live.
    now: () => (clock += 1)
  })
  expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('no history page')
  }
  client = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'history-page',
    page: page.page
  })
  host.subscribe({
    id: 'client',
    sessionId: SESSION,
    cursor: page.page.liveCursor ?? page.page.window.nextCursor,
    emit: (event) => {
      client = reduceStructuredAgentSession(client, { type: 'event', event })
    }
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function codexPrompts(): CodexJournalPrompts {
  if (!sink) {
    throw new Error('session was never acquired')
  }
  return new CodexJournalPrompts(
    { sink, attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }) },
    () => null,
    () => 'turn-1'
  )
}

async function ask(prompts: CodexJournalPrompts, asked: Asked = ASKED): Promise<void> {
  prompts.handle({
    threadId: THREAD,
    method: CODEX_USER_INPUT_METHOD,
    codexItemId: 'codex-item-1',
    promptKey: '7',
    params: {
      threadId: THREAD,
      turnId: 'turn-1',
      questions: asked.map((question) => ({
        ...question,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' }
        ]
      }))
    }
  })
  await host.flushStreamedEvents(SESSION)
}

function questionItem(question: string): AgentJournalRenderItem {
  const item = client.items.find(
    (candidate) => candidate.body.kind === 'question' && candidate.body.question === question
  )
  if (!item || item.body.kind !== 'question') {
    throw new Error(`no journal item for ${question}`)
  }
  return item
}

async function answer(question: string): Promise<void> {
  const item = questionItem(question)
  if (item.body.kind !== 'question') {
    return
  }
  const fields = {
    itemId: item.itemId,
    expectedRevision: item.revision,
    optionId: item.body.options[0]!.id
  }
  const result = await host.respondToPrompt(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.respondTo:question',
        sessionId: SESSION,
        fields
      })
    },
    kind: 'question',
    ...fields
  })
  expect(result.ok).toBe(true)
  await host.flushStreamedEvents(SESSION)
}

/** The prompt rows the transcript list draws, top to bottom, as the questions each one shows. */
function drawnPromptRows(): string[][] {
  const { receipts } = structuredQuestionTranscript(client.items)
  // The desktop list's projection: its comparator adds only a rank for rows the host never writes.
  const rows = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(
      client.items,
      [],
      client.submissions,
      projectStructuredQuestionMessages
    )
  )
  return rows.flatMap((row) => {
    const prompt = receipts.get(row.id)
    if (!prompt || prompt.kind !== 'question') {
      return []
    }
    const questions = prompt.questions?.length ? prompt.questions : [prompt]
    return [questions.map(({ question }) => `${question} (${prompt.resolution.state})`)]
  })
}

describe('a Codex ask with several questions', () => {
  it('keeps the pending rest of the ask below the question already answered', async () => {
    await ask(codexPrompts())
    await answer(ASKED[0]!.question)

    expect(drawnPromptRows()).toEqual([
      ['Which files are in scope? (resolved)'],
      ['What matters most? (pending)', 'When is it due? (pending)']
    ])
  })

  it('draws every answered question in the order Codex asked it', async () => {
    await ask(codexPrompts())
    for (const { question } of ASKED) {
      await answer(question)
    }

    expect(drawnPromptRows()).toEqual([
      ['Which files are in scope? (resolved)'],
      ['What matters most? (resolved)'],
      ['When is it due? (resolved)']
    ])
    // Mobile draws the shared projection in journal order, one row per question.
    expect(
      projectStructuredAgentSessionMessages(client.items, [], client.submissions).map(
        ({ blocks }) => (blocks[0]?.type === 'text' ? blocks[0].text.split('\n')[0] : null)
      )
    ).toEqual(ASKED.map(({ question }) => question))
  })

  it('draws a cancelled ask in the order Codex asked it', async () => {
    const prompts = codexPrompts()
    await ask(prompts, ASKED_OUT_OF_ORDER)
    prompts.cancel(questionItem(ASKED_OUT_OF_ORDER[0]!.question).itemId)
    await host.flushStreamedEvents(SESSION)

    expect(drawnPromptRows()).toEqual([
      ['Which format? (cancelled)'],
      ['Who reads it? (cancelled)'],
      ['How long? (cancelled)']
    ])
  })
})
