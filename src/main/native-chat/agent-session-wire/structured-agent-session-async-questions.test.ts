import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem,
  type AgentJournalRenderItem,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { codexItemIdentity, codexJournalItem } from '../../codex/codex-structured-item-translation'
import { CodexTurnOrdinals } from '../../codex/codex-turn-ordinals'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { digestPayload } from '../agent-session-journal/journal-payload-bounds'
import {
  NATIVE_CHAT_ASYNC_QUESTIONS_PUBLICATION_BYTES,
  nativeChatAsyncQuestionsFieldBytes
} from '../../../shared/native-chat-async-questions'
import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime-memory-limits'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'
import { deriveJournalAsyncQuestions } from '../../../shared/native-chat-async-question-facts'
import { readAgentSessionHistory } from './agent-session-history-page'
import { readStructuredAgentSessionAsyncQuestions } from './structured-agent-session-status-journal-projection'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { asyncQuestionsFrameReserveBytes } from './agent-session-subscriber-frame-fields'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-async',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const OPTIONS = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-async-journal-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const open = (): Promise<AgentSessionJournal> =>
  journals.open({ identity: IDENTITY, stateDirectory: root })

function asking(title: string): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: title,
        asyncQuestions: { providerItemId: `raw-${title}`, questions: [{ title }] }
      }
    ]
  }
}

let ordinal = 0
function codexIdentity(): AgentJournalItemIdentity {
  ordinal += 1
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

async function ask(journal: AgentSessionJournal, title: string): Promise<void> {
  await journal.appendItem(codexIdentity(), asking(title), OPTIONS)
}

async function submit(
  journal: AgentSessionJournal,
  clientMessageId: string,
  queued = false
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: digestPayload(clientMessageId),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    fence: 1,
    ...(queued ? { handoverRecorded: true as const } : {})
  })
}

async function accept(journal: AgentSessionJournal, clientMessageId: string): Promise<void> {
  await journal.resolveDispatch({
    clientMessageId,
    state: 'accepted',
    providerIdentity: codexIdentity(),
    fence: 1
  })
}

function titles(journal: AgentSessionJournal): string[] {
  const field = readStructuredAgentSessionAsyncQuestions(journal)
  return field?.state === 'ready' ? field.questions.map((question) => question.title) : []
}

describe('structured async questions retire at the transport canonical order', () => {
  it('a direct send retires what was asked before it, once accepted', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await ask(journal, 'B before tap?')
    await submit(journal, 'm1')
    expect(titles(journal)).toEqual(['A?', 'B before tap?'])
    await accept(journal, 'm1')
    expect(titles(journal)).toEqual([])
  })

  it('a question asked between submission and acceptance stays pending', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await submit(journal, 'm1')
    await ask(journal, 'B between?')
    await accept(journal, 'm1')
    expect(titles(journal)).toEqual(['B between?'])
    await ask(journal, 'C after?')
    expect(titles(journal)).toEqual(['B between?', 'C after?'])
  })

  it('a queued send counts at its handover, so a question asked before it is retired', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await submit(journal, 'q1', true)
    await ask(journal, 'B before handover?')
    expect(titles(journal)).toEqual(['A?', 'B before handover?'])
    await journal.resolveDispatch({
      clientMessageId: 'q1',
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: 1
    })
    await accept(journal, 'q1')
    expect(titles(journal)).toEqual([])
  })

  it('derives the same set and keys after a replay', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await submit(journal, 'm1')
    await ask(journal, 'B?')
    await accept(journal, 'm1')
    const before = readStructuredAgentSessionAsyncQuestions(journal)
    await journal.close()
    const replayed = await open()
    expect(readStructuredAgentSessionAsyncQuestions(replayed)).toEqual(before)
  })

  it('caches by cursor and keeps the published identity while unchanged', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    const first = readStructuredAgentSessionAsyncQuestions(journal)
    expect(readStructuredAgentSessionAsyncQuestions(journal)).toBe(first)
    await journal.appendItem(
      codexIdentity(),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'more work' }] },
      OPTIONS
    )
    expect(readStructuredAgentSessionAsyncQuestions(journal)).toBe(first)
  })

  it('reads only what follows the newest delivered user message, never a sorted snapshot', async () => {
    const journal = await open()
    const steps: (() => Promise<void>)[] = [
      () => ask(journal, 'A?'),
      () => submit(journal, 'm1'),
      () => ask(journal, 'B?'),
      () => accept(journal, 'm1'),
      () => ask(journal, 'C?'),
      () => submit(journal, 'm2'),
      () => accept(journal, 'm2'),
      () => ask(journal, 'D?')
    ]
    for (const step of steps) {
      await step()
      const snapshot = vi.spyOn(journal, 'snapshot')
      const incremental = titles(journal)
      expect(snapshot).not.toHaveBeenCalled()
      snapshot.mockRestore()
      const { items, submissions } = journal.snapshot()
      expect(incremental).toEqual(
        deriveJournalAsyncQuestions(items, submissions).map((question) => question.title)
      )
    }
    // With no send pending after the boundary, the submissions aren't read either.
    const submissions = vi.spyOn(journal, 'submissions')
    await ask(journal, 'E?')
    expect(titles(journal)).toEqual(['D?', 'E?'])
    expect(submissions).not.toHaveBeenCalled()
  })

  it('does no work for a session whose provider never asks async questions', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    const visit = vi.spyOn(journal, 'visitItemsWithLinkage')
    expect(readStructuredAgentSessionAsyncQuestions(journal, 'claude')).toEqual({
      state: 'ready',
      questions: []
    })
    expect(visit).not.toHaveBeenCalled()
  })

  it('publishes nothing for a read-only journal, which cannot derive the set', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    expect(titles(journal)).toEqual(['A?'])
    const readOnly = vi.spyOn(journal, 'isReadOnly', 'get').mockReturnValue(true)
    expect(readStructuredAgentSessionAsyncQuestions(journal)).toBeUndefined()
    readOnly.mockRestore()
    expect(titles(journal)).toEqual(['A?'])
  })
})

describe('structured async question identity across resume', () => {
  it('keeps the key when the resumed provider renumbers the asking item', async () => {
    const journal = await open()
    const questions = [{ title: 'Color?', options: ['Red'] }]
    const live = {
      type: 'agentMessage',
      id: 'call_live',
      text: 'Color?',
      delivery: 'async',
      questions
    }
    const resumed = { ...live, id: 'item-2' }
    const liveOrdinals = new CodexTurnOrdinals()
    liveOrdinals.ordinalFor('thread-1', 'turn-9', 'user-live')
    const resumedOrdinals = new CodexTurnOrdinals()
    resumedOrdinals.ordinalFor('thread-1', 'turn-9', 'item-1')

    const write = async (item: typeof live, ordinals: CodexTurnOrdinals): Promise<void> => {
      const body = codexJournalItem(item).body
      if (!body) {
        throw new Error('expected a message body')
      }
      const identity = codexItemIdentity({ threadId: 'thread-1', turnId: 'turn-9', item, ordinals })
      await journal.appendItem(identity, body, OPTIONS)
    }
    await write(live, liveOrdinals)
    const liveKeys = readStructuredAgentSessionAsyncQuestions(journal)
    await write(resumed, resumedOrdinals)
    const resumedKeys = readStructuredAgentSessionAsyncQuestions(journal)
    expect(liveKeys?.state).toBe('ready')
    expect(liveKeys?.state === 'ready' && liveKeys.questions.map((q) => q.key)).toEqual(
      resumedKeys?.state === 'ready' && resumedKeys.questions.map((q) => q.key)
    )
    // The raw provider id is carried separately and never used as client state.
    expect(resumedKeys?.state === 'ready' && resumedKeys.questions[0]?.providerItemId).toBe(
      'item-2'
    )

    // A genuine re-ask is a new item, so a new key.
    const reAsk = { ...live, id: 'call_again' }
    await write(reAsk, resumedOrdinals)
    const after = readStructuredAgentSessionAsyncQuestions(journal)
    expect(after?.state === 'ready' ? new Set(after.questions.map((q) => q.key)).size : 0).toBe(2)
  })
})

describe('structured async questions on subscribe frames', () => {
  it('carries a question older than the hydration page on the snapshot and reset frames', async () => {
    const journal = await open()
    await ask(journal, 'Old?')
    for (let index = 0; index < 260; index += 1) {
      await journal.appendItem(
        codexIdentity(),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `row ${index}` }] },
        OPTIONS
      )
    }
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      readAsyncQuestions: (_sessionId, journal) => readStructuredAgentSessionAsyncQuestions(journal)
    })
    subscribers.open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const snapshot = events[0]
    expect(snapshot?.type).toBe('snapshot')
    if (snapshot?.type !== 'snapshot') {
      return
    }
    expect(JSON.stringify(snapshot.page.items)).not.toContain('Old?')
    expect(snapshot.asyncQuestions).toMatchObject({
      state: 'ready',
      questions: [{ title: 'Old?' }]
    })

    subscribers.reset(IDENTITY.sessionId, journal, 'cursor_compacted', 1)
    expect(events.at(-1)).toMatchObject({
      type: 'reset',
      asyncQuestions: { state: 'ready', questions: [{ title: 'Old?' }] }
    })
  })

  it('attaches the field to a batch only when the set changed', async () => {
    const journal = await open()
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      readAsyncQuestions: (_sessionId, journal) => readStructuredAgentSessionAsyncQuestions(journal)
    })
    subscribers.open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    await journal.appendItem(
      codexIdentity(),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'work' }] },
      OPTIONS
    )
    subscribers.publish(IDENTITY.sessionId, journal)
    expect(events.at(-1)).toMatchObject({ type: 'batch' })
    expect(events.at(-1)).not.toHaveProperty('asyncQuestions')

    await ask(journal, 'New?')
    subscribers.publish(IDENTITY.sessionId, journal)
    expect(events.at(-1)).toMatchObject({
      type: 'batch',
      asyncQuestions: { state: 'ready', questions: [{ title: 'New?' }] }
    })
  })

  it('gives a resumed, already caught-up cursor the set it was never sent', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers({
      readAsyncQuestions: (_sessionId, journal) => readStructuredAgentSessionAsyncQuestions(journal)
    }).open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      cursor: journal.cursor(),
      emit: (event) => events.push(event)
    })
    expect(events).toEqual([
      expect.objectContaining({
        type: 'batch',
        asyncQuestions: { state: 'ready', questions: [expect.objectContaining({ title: 'A?' })] }
      })
    ])
  })
})

describe('structured async questions on a resumed, multi-page catch-up', () => {
  it('carries the set on the first page even though more pages follow, then only on change', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    const resumeFrom = journal.cursor()
    for (let index = 0; index < 400; index += 1) {
      await journal.appendItem(
        codexIdentity(),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `row ${index}` }] },
        OPTIONS
      )
    }
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers({
      readAsyncQuestions: (_sessionId, journal) => readStructuredAgentSessionAsyncQuestions(journal)
    }).open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      cursor: resumeFrom,
      emit: (event) => events.push(event)
    })
    const batches = events.filter((event) => event.type === 'batch')
    expect(batches.length).toBeGreaterThan(1)
    expect(batches[0]).toMatchObject({
      asyncQuestions: { state: 'ready', questions: [{ title: 'A?' }] }
    })
    expect(batches.slice(1).every((event) => !('asyncQuestions' in event))).toBe(true)
  })
})

describe('structured async questions against the frame byte budget', () => {
  it('holds back only the field it carries: a large message still renders on every page', async () => {
    const journal = await open()
    const large = 'x'.repeat(1_800_000)
    await journal.appendItem(
      codexIdentity(),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: large }] },
      OPTIONS
    )
    const rendersLarge = (items: readonly AgentJournalRenderItem[]): boolean =>
      items.some(
        (item) =>
          item.body.kind === 'message' &&
          item.body.blocks.some((block) => block.type === 'text' && block.text === large)
      )
    // A history page carries no field, so it keeps the whole budget.
    const history = readAgentSessionHistory(journal, {
      sessionId: IDENTITY.sessionId,
      direction: 'tail'
    })
    expect(history.ok && rendersLarge(history.page.items)).toBe(true)
    // A subscribe snapshot holds back only what its (empty) set takes.
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers({
      readAsyncQuestions: (_sessionId, journal) => readStructuredAgentSessionAsyncQuestions(journal)
    }).open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const snapshot = events[0]
    expect(snapshot?.type === 'snapshot' && rendersLarge(snapshot.page.items)).toBe(true)
  })

  /** Rows large enough that the hydration page is cut by bytes, well before its row limit. */
  async function fillPageBudget(journal: AgentSessionJournal): Promise<number> {
    const rows = 12
    for (let index = 0; index < rows; index += 1) {
      await journal.appendItem(
        codexIdentity(),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `row ${index} ${'x'.repeat(200 * 1024)}` }]
        },
        OPTIONS
      )
    }
    return rows
  }

  function snapshotOf(journal: AgentSessionJournal) {
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers({
      readAsyncQuestions: (_sessionId, journal) => readStructuredAgentSessionAsyncQuestions(journal)
    }).open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const snapshot = events[0]
    if (snapshot?.type !== 'snapshot') {
      throw new Error('expected a snapshot frame')
    }
    return snapshot
  }

  it('carries a question older than the byte-budget page on the snapshot', async () => {
    const journal = await open()
    await ask(journal, 'Old?')
    const rows = await fillPageBudget(journal)

    const snapshot = snapshotOf(journal)

    expect(snapshot.page.items.length).toBeLessThan(rows)
    expect(snapshot.page.hasOlder).toBe(true)
    expect(JSON.stringify(snapshot.page.items)).not.toContain('Old?')
    expect(snapshot.asyncQuestions).toMatchObject({
      state: 'ready',
      questions: [{ title: 'Old?' }]
    })
  })

  it('publishes the oldest questions that fit and keeps a full frame under the page limit', async () => {
    const journal = await open()
    // Maximum-size titles: far more than the side field's budget can carry.
    const asked = 1200
    for (let index = 0; index < asked; index += 1) {
      await ask(journal, `${String(index).padStart(4, '0')} ${'q'.repeat(500)}`)
    }
    await fillPageBudget(journal)

    const snapshot = snapshotOf(journal)
    const field = snapshot.asyncQuestions
    if (field?.state !== 'ready') {
      throw new Error('expected a published set')
    }

    expect(field.questions.length).toBeGreaterThan(0)
    expect(field.omittedCount).toBe(asked - field.questions.length)
    expect(field.questions[0]?.title.startsWith('0000 ')).toBe(true)
    expect(nativeChatAsyncQuestionsFieldBytes(field)).toBeLessThanOrEqual(
      NATIVE_CHAT_ASYNC_QUESTIONS_PUBLICATION_BYTES
    )
    // The history page was packed to its budget with the field's share held back, so the
    // whole frame, field included, stays inside the page limit and the transport accepts it,
    // for a reader that ignores the field too (its reduction: cross-version-wire suite).
    expect(snapshot.page.hasOlder).toBe(true)
    const frameBytes = Buffer.byteLength(serializeRemoteRuntimePayload(snapshot), 'utf8')
    expect(frameBytes).toBeLessThanOrEqual(AGENT_SESSION_HISTORY_MAX_PAGE_BYTES)
  })

  it('measures a published set once while its identity holds, not on every delivery', async () => {
    const journal = await open()
    const field = {
      state: 'ready' as const,
      questions: [{ key: 'q', index: 0, title: 'Color?' }]
    }
    const hooks = { readAsyncQuestions: () => field }
    const first = asyncQuestionsFrameReserveBytes(hooks, IDENTITY.sessionId, journal)
    expect(first).toBe(nativeChatAsyncQuestionsFieldBytes(field))
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(asyncQuestionsFrameReserveBytes(hooks, IDENTITY.sessionId, journal)).toBe(first)
      expect(stringify).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })
})
