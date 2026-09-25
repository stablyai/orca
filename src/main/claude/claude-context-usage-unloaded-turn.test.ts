import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionHistoryPage } from '../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  latestStructuredAgentContextFacts,
  selectStructuredAgentContextUsage
} from '../../shared/structured-agent-session-context-usage'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../shared/structured-agent-session-reducer'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import { readAgentSessionHistory } from '../native-chat/agent-session-wire/agent-session-history-page'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionMutationContext } from '../native-chat/agent-session-wire/structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-options-read'
import {
  assistantFrame,
  initFrame,
  resultFrame,
  userFrame
} from './claude-context-usage-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const SESSION = 'orca-session'
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-context-unloaded-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
    },
    now: () => 9_000,
    journalDir: join(root, SESSION)
  })
}

function translate(journal: AgentSessionJournal) {
  const deferred = createDeferredStructuredAgentSessionEventSink()
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, coalesceMs: 0 })
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const settle = async (): Promise<void> => {
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
  }
  return { translator, settle }
}

/** A turn long enough that a small tail page starts after its turn row. */
function runTurn(
  translator: ReturnType<typeof translate>['translator'],
  turnId: string,
  at: number,
  sizes: number[]
): void {
  translator.handle(initFrame('claude-fable-5-1[1m]', at - 100))
  translator.handle(userFrame(turnId, at))
  sizes.forEach((size, index) => {
    translator.handle(assistantFrame(`${turnId}-reply-${index}`, at + 100 * (index + 1), size))
  })
}

function readOptions(
  journal: AgentSessionJournal,
  adapter: Partial<StructuredAgentSessionAdapter>
) {
  const running = { journal, fence: 1, hasProviderChild: true, params: { provider: 'claude' } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the options read touches only these members.
  const context = {
    deps: {
      adapter: {
        readOptions: async () => ({ models: [], current: { model: 'opus' } }),
        ...adapter
      },
      store: { getRecord: () => undefined }
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => running,
    conversation: async () => running
  } as unknown as StructuredAgentSessionMutationContext
  return readStructuredAgentSessionOptions(context, SESSION)
}

function attachTail(journal: AgentSessionJournal, limit: number): StructuredAgentSessionState {
  const read = readAgentSessionHistory(journal, { sessionId: SESSION, direction: 'tail', limit })
  if (!read.ok) {
    throw new Error('tail read failed')
  }
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: { type: 'snapshot', sessionId: SESSION, fence: 1, page: read.page }
  })
}

function applyLive(
  journal: AgentSessionJournal,
  state: StructuredAgentSessionState
): StructuredAgentSessionState {
  const read = readAgentSessionHistory(journal, {
    sessionId: SESSION,
    direction: 'after',
    cursor: state.cursor ?? undefined
  })
  if (!read.ok) {
    throw new Error('live read failed')
  }
  const page: AgentSessionHistoryPage = read.page
  return reduceStructuredAgentSession(state, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: SESSION,
      batch: {
        cursor: page.window.nextCursor,
        items: page.items,
        removedItemIds: page.removedItemIds,
        submissions: page.submissions
      }
    }
  })
}

const hasTurnRow = (state: StructuredAgentSessionState): boolean =>
  state.items.some((item) => readAgentJournalTurn(item.body) !== null)

function catchUp(
  journal: AgentSessionJournal,
  state: StructuredAgentSessionState
): StructuredAgentSessionState {
  let next = applyLive(journal, state)
  while (next.cursor?.sequence !== state.cursor?.sequence) {
    state = next
    next = applyLive(journal, state)
  }
  return next
}

describe('context usage for a turn row outside the loaded page', () => {
  it('shows the ring on a reopened chat from the host whole-journal answer', async () => {
    const journal = await openJournal()
    const { translator, settle } = translate(journal)
    runTurn(translator, 'turn-a', 1_000, [120_000, 130_000, 140_000, 150_000, 160_000])
    translator.handle(resultFrame(2_000, { 'claude-fable-5-1[1m]': { contextWindow: 1_000_000 } }))
    await settle()

    const state = attachTail(journal, 3)
    expect(state.hasOlder).toBe(true)
    expect(hasTurnRow(state)).toBe(false)
    const options = await readOptions(journal, { recordsContextUsage: () => true })

    expect(options.contextUsage?.current).toEqual(
      latestStructuredAgentContextFacts(journal.snapshot().items)
    )
    expect(selectStructuredAgentContextUsage(state.items, options.contextUsage?.current)).toEqual(
      selectStructuredAgentContextUsage(journal.snapshot().items)
    )
    expect(
      selectStructuredAgentContextUsage(state.items, options.contextUsage?.current)
    ).toMatchObject({ usedTokens: 160_000, windowTokens: 1_000_000, estimated: true })
  })

  it('leaves the options answer untouched on a session that writes no context facts', async () => {
    const journal = await openJournal()
    const { translator, settle } = translate(journal)
    runTurn(translator, 'turn-a', 1_000, [120_000, 130_000, 140_000])
    await settle()

    const options = await readOptions(journal, {})
    expect(options).not.toHaveProperty('contextUsage')
    // An older host answers the same way, so the ring reads only the loaded page, as before.
    expect(selectStructuredAgentContextUsage(attachTail(journal, 2).items)).toBeNull()
  })

  it('marks a live context write on a turn row the window cannot take, and the host answer carries it', async () => {
    const journal = await openJournal()
    const { translator, settle } = translate(journal)
    runTurn(translator, 'turn-a', 1_000, [120_000, 130_000, 140_000, 150_000])
    translator.handle(resultFrame(2_000, { 'claude-fable-5-1[1m]': { contextWindow: 1_000_000 } }))
    runTurn(translator, 'turn-b', 3_000, [200_000, 210_000, 220_000, 230_000])
    await settle()
    const attached = attachTail(journal, 3)
    expect(hasTurnRow(attached)).toBe(false)
    expect(attached.unloadedTurnRevisions).toBeUndefined()

    translator.handle(assistantFrame('turn-b-reply-late', 4_000, 250_000))
    await settle()
    const live = applyLive(journal, attached)

    expect(hasTurnRow(live)).toBe(false)
    expect(live.unloadedTurnRevisions).toBe(1)
    const options = await readOptions(journal, { recordsContextUsage: () => true })
    expect(
      selectStructuredAgentContextUsage(live.items, options.contextUsage?.current)
    ).toMatchObject({ usedTokens: 250_000, windowTokens: 1_000_000 })
  })

  it('keeps the ring on the newest facts while a live turn outgrows the retained window', async () => {
    const journal = await openJournal()
    const { translator, settle } = translate(journal)
    runTurn(translator, 'turn-a', 1_000, [120_000])
    translator.handle(resultFrame(2_000, { 'claude-fable-5-1[1m]': { contextWindow: 1_000_000 } }))
    runTurn(translator, 'turn-b', 3_000, [])
    await settle()
    const hostAnswer = async () =>
      (await readOptions(journal, { recordsContextUsage: () => true })).contextUsage?.current
    // The client reads the host once per turn, and again whenever its window loses a turn row.
    let state = attachTail(journal, 200)
    let host = await hostAnswer()
    const respond = (index: number): void => {
      translator.handle(assistantFrame(`turn-b-reply-${index}`, 4_000 + index, 200_000 + index))
    }
    let index = 0
    for (; index < 1_900; index += 1) {
      respond(index)
    }
    await settle()
    state = catchUp(journal, state)
    expect(hasTurnRow(state)).toBe(true)

    // Step one response at a time across the batch that trims the turn row out, and past it.
    let stepsAfterTrim = 0
    while (stepsAfterTrim < 5 && index < 3_000) {
      respond(index++)
      await settle()
      const seen = state.unloadedTurnRevisions
      state = catchUp(journal, state)
      if (state.unloadedTurnRevisions !== seen) {
        host = await hostAnswer()
      }
      expect(selectStructuredAgentContextUsage(state.items, host)).toEqual(
        selectStructuredAgentContextUsage(journal.snapshot().items)
      )
      stepsAfterTrim += hasTurnRow(state) ? 0 : 1
    }
    expect(hasTurnRow(state)).toBe(false)
  })
})
