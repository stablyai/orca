import { registerCodexHistorySourcesTests } from './codex-structured-thread-catch-up-sources.spec'
import { registerCodexHistoryVariantsTests } from './codex-structured-thread-catch-up-variants.spec'
import { registerCodexHistoryBoundsTests } from './codex-structured-thread-catch-up-bounds.spec'
import {
  adapterFor,
  fakeCodex,
  acquireReadyCodexForTest
} from './codex-structured-session-adapter-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { journalItemEchoFields } from '../native-chat/agent-session-journal/journal-item-echo'
import { expect, it } from 'vitest'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  chat as catchUpChat,
  codexWith as catchUpCodexWith,
  turn as catchUpTurn
} from './codex-structured-thread-catch-up.test'
import { agentSessionSendBodyFingerprint } from '../../shared/structured-agent-session-send-mutation'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { structuredRewindCut } from '../native-chat/agent-session-wire/structured-rewind-cut'
import {
  applyJournalRow,
  createJournalReducerState
} from '../native-chat/agent-session-journal/journal-reducer'

export function registerCodexCatchUpEchoTests(input: {
  codexWith: typeof catchUpCodexWith
  chat: typeof catchUpChat
  turn: typeof catchUpTurn
  sessionId: string
  threadId: string
}): void {
  const { chat, turn, codexWith, sessionId: SESSION, threadId: THREAD } = input
  registerCodexHistorySourcesTests(input)
  registerCodexHistoryVariantsTests(input)
  registerCodexHistoryBoundsTests(input)
  it('reconciles older completed acquired content and keeps unchanged reacquisition write-free', async () => {
    const c = await chat({ now: 1_000 })
    const first = turn(1)
    await c.open([], {
      returnedTurns: [
        { ...first, items: Array.isArray(first.items) ? first.items.slice(0, 1) : [] }
      ],
      paginate: false
    })
    await c.open([], { returnedTurns: [turn(2)], paginate: false })
    const whole = [turn(1), turn(2)]
    await c.open([], { returnedTurns: whole, paginate: false })
    expect(c.texts()).toContain('assistant:answer 1')
    const before = c.journal.cursor()
    await c.reopen()
    await c.open([], { returnedTurns: whole, paginate: false })
    expect(c.journal.cursor()).toEqual(before)
    expect(c.texts().filter((text) => text === 'assistant:answer 1')).toHaveLength(1)
  })

  it('selects acquired history linearly at N and 10N without copying the saved turn set', async () => {
    const counts: number[] = []
    for (const n of [100, 1_000]) {
      const c = await chat({ now: 1_000 })
      const turns: Record<string, unknown>[] = []
      for (let i = 0; i < n; i++) {
        await c.journal.appendItem(
          { provider: 'codex', threadId: THREAD, turnId: `turn-${i}`, ordinal: 0 },
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'saved' }] },
          { fence: 1, turnScope: { kind: 'thread' } }
        )
        turns.push({ ...turn(i), items: [] })
      }
      let visits = 0
      const iterator = Set.prototype[Symbol.iterator]
      Set.prototype[Symbol.iterator] = function* () {
        const tracked = this.size === n && this.has('turn-0')
        for (const value of iterator.call(this)) {
          if (tracked) {
            visits++
          }
          yield value
        }
        return undefined
      }
      try {
        await c.open([], { returnedTurns: turns, paginate: false })
      } finally {
        Set.prototype[Symbol.iterator] = iterator
      }
      counts.push(visits)
    }
    expect(counts[1]).toBeLessThanOrEqual(counts[0]! * 12)
    expect(counts[1]).toBeLessThan(20_000)
    console.info('history selection set-entry visits N=100/1000:', counts)
  })

  it('uses saved native IDs only for display, preserving sends and drafts through outside echoes and replay', async () => {
    const c = await chat({ now: 1_000 })
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'continue' },
        { type: 'image-ref', path: '/attachment.png' }
      ]
    }
    const fingerprint = agentSessionSendBodyFingerprint(SESSION, body)
    await c.journal.queuedMessages.insert({
      messageId: 'draft',
      body
    })
    const states = ['unknown', 'rejected'] as const
    for (const state of states) {
      await c.journal.appendSubmission(
        {
          clientMessageId: state,
          body,
          payloadFingerprint: fingerprint,
          fence: 1,
          handoverRecorded: true
        },
        state === 'rejected' ? { messageId: 'draft', expect: 'waiting' } : undefined
      )
      await c.journal.resolveDispatch({
        clientMessageId: state,
        state: 'pending',
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await (state === 'unknown'
        ? c.journal.markPendingSubmissionsUnknown(1)
        : c.journal.resolveDispatch({
            clientMessageId: state,
            state: 'rejected',
            ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
              surface: 'rejection'
            }),
            fence: 1
          }))
    }
    await c.reopen()
    const before = c.journal.snapshot()
    const draft = c.journal.queuedMessages.get('draft')
    const receipts = states.map((state) => c.journal.receiptFor(state))
    const native = states.map((state, n) => ({
      ...turn(n + 2),
      items: [
        {
          type: 'userMessage',
          id: `u-${n + 2}`,
          clientId: state,
          content: [{ type: 'text', text: 'different historical rendering' }]
        },
        { type: 'agentMessage', id: `a-${n + 2}`, text: `answer ${n + 2}` }
      ]
    }))
    const outside = {
      ...turn(7),
      items: [
        {
          type: 'userMessage',
          id: 'outside',
          clientId: 'foreign-request',
          content: [
            { type: 'text', text: 'continue' },
            { type: 'localImage', path: '/attachment.png' }
          ]
        },
        { type: 'agentMessage', id: 'outside-answer', text: 'outside answer' }
      ]
    }
    await c.open([...native, outside])
    expect(c.texts().slice(-4)).toEqual([
      'assistant:answer 3',
      '(continued-outside)',
      'user:continue',
      'assistant:outside answer'
    ])
    expect(c.journal.snapshot().items.slice(0, before.items.length)).toEqual(before.items)
    expect(states.map((state) => c.journal.receiptFor(state))).toEqual(receipts)
    expect(c.texts().filter((text) => text.includes('historical rendering'))).toEqual([])
    expect(c.journal.snapshot().submissions).toEqual(before.submissions)
    expect(c.journal.queuedMessages.get('draft')).toEqual(draft)
    const outsideKey = agentJournalItemKey({
      provider: 'codex',
      threadId: THREAD,
      turnId: 'turn-7',
      ordinal: 0
    })
    expect(journalItemEchoFields(c.journal.itemProvenance(outsideKey))).toEqual({ echoOf: null })
    const whole = c.journal.snapshot()
    await c.reopen()
    await c.open([...native, outside])
    expect(c.journal.snapshot()).toEqual(whole)
    expect(c.journal.queuedMessages.get('draft')).toEqual(draft)
    const replay = c.journal.readSince({ epoch: c.journal.epoch, sequence: 0 })
    if (!replay.ok || !draft) {
      throw new Error('missing replay fixture')
    }
    const state = createJournalReducerState(SESSION, c.journal.epoch)
    for (const row of replay.rows) {
      applyJournalRow(state, row)
    }
    expect(state.queue.cards.get('draft')).toEqual(draft)
  })

  it('keeps native display identity after a real retained cut and disk reopen', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([turn(1)])
    const clientMessageId = `native-${'u'.repeat(1100)}`
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'original rich prompt' },
        { type: 'image-ref', path: '/kept.png' }
      ]
    }
    await c.journal.appendSubmission({
      clientMessageId,
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body),
      fence: 1,
      handoverRecorded: true
    })
    await c.journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await c.journal.markPendingSubmissionsUnknown(1)
    await c.open([turn(1), turn(2), turn(3)])
    const key = agentJournalItemKey({ provider: 'orca', clientMessageId })
    const cut = structuredRewindCut(c.journal, {
      itemId: agentJournalItemKey({
        provider: 'codex',
        threadId: THREAD,
        turnId: 'turn-3',
        ordinal: 0
      }),
      provider: 'codex',
      nativeId: THREAD
    })
    if (!cut) {
      throw new Error('missing native retention cut')
    }
    await c.journal.replaceEpochItems('handle_forked', 1, cut.kept)
    await c.reopen()
    const prompt = c.journal.item(key)
    expect(prompt?.body).toEqual(body)
    expect(c.journal.submission(clientMessageId)?.dispatchState).toBe('unknown')
    const native = {
      ...turn(4),
      items: [
        {
          type: 'userMessage',
          id: 'native',
          clientId: clientMessageId,
          content: [{ type: 'text', text: 'provider rendering' }]
        },
        { type: 'agentMessage', id: 'reply', text: 'native answer' }
      ]
    }
    const before = c.journal.snapshot()
    const beforeTexts = c.texts()
    await c.open([turn(1), turn(2), native])
    expect(c.journal.item(key)).toEqual(prompt)
    expect(c.journal.snapshot().items.slice(0, before.items.length)).toEqual(before.items)
    expect(c.texts()).toEqual([...beforeTexts, 'assistant:native answer'])
    expect(c.journal.submission(clientMessageId)?.dispatchState).toBe('unknown')
    expect(c.journal.receiptFor(clientMessageId)).toBeNull()
    const whole = c.journal.snapshot()
    await c.reopen()
    await c.open([turn(1), turn(2), native])
    expect(c.journal.snapshot()).toEqual(whole)
    await c.journal.replaceEpochItems('handle_forked', 1, [])
    const hidden = c.journal.cursor()
    const { readCodexHistoryJournalView } = await import('./codex-history-journal-view')
    expect(readCodexHistoryJournalView(c.journal, THREAD).latest).toBeNull()
    await c.open([native], {
      onReceipt: (id, providerIdentity) =>
        c.journal.acceptLate({ clientMessageId: id, providerIdentity, state: 'accepted', fence: 1 })
    })
    expect(c.journal.submission(clientMessageId)?.dispatchState).toBe('accepted')
    expect(c.journal.item(key)).toBeNull()
    expect(c.journal.snapshot().items).toEqual([])
    expect(readCodexHistoryJournalView(c.journal, THREAD).latest).toBeNull()
    expect(c.journal.cursor().epoch).toBe(hidden.epoch)
    await c.reopen()
    await c.open([native])
    expect(c.journal.snapshot().items).toEqual([])
  })

  it('completes a represented turn and older gaps through an actual paginated open with partial returned content', async () => {
    const c = await chat({ now: 1_000 })
    const original = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'native' }]
    }
    await c.journal.appendSubmission({
      clientMessageId: 'P',
      body: original,
      payloadFingerprint: 'P',
      fence: 1
    })
    await c.journal.resolveDispatch({
      clientMessageId: 'P',
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 0 },
      fence: 1
    })
    const current: Record<string, unknown> & { items: Record<string, unknown>[] } = {
      ...turn(2),
      items: [
        {
          type: 'userMessage',
          id: 'u-2',
          clientId: 'P',
          content: [{ type: 'text', text: 'native' }]
        },
        { type: 'agentMessage', id: 'a-2', text: 'completed answer' }
      ]
    }
    const detailIdentity = {
      provider: 'orca' as const,
      clientMessageId: `codex-item:${THREAD}:exec-2`
    }
    await c.journal.appendItem(
      detailIdentity,
      { kind: 'tool-call', name: 'terminal', input: { command: 'pwd' }, state: 'running' },
      {
        fence: 1,
        turnScope: {
          kind: 'turn',
          turnItemId: agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, 'turn-2'))
        }
      }
    )
    current.items.push({
      type: 'commandExecution',
      id: 'exec-2',
      command: 'pwd',
      status: 'completed',
      aggregatedOutput: '/workspace',
      exitCode: 0
    })
    const first = turn(1)
    await c.open([], {
      returnedTurns: [
        { ...first, items: Array.isArray(first.items) ? first.items.slice(0, 1) : [] }
      ],
      paginate: false
    })
    const turns = [first, current]
    const source = codexWith(turns)
    let fullReads = 0
    const codex = fakeCodex({
      'thread/resume': () => ({
        thread: {
          id: THREAD,
          historyMode: 'paginated',
          turns: [{ ...current, items: current.items.slice(0, 1) }]
        }
      }),
      'thread/turns/list': async (params) => {
        if (params?.itemsView === 'full') {
          fullReads++
        }
        const page = await source.request('thread/turns/list', params)
        return params?.itemsView === 'summary'
          ? {
              ...page,
              data: page.data.map((turn) => ({
                ...turn,
                itemsView: 'summary',
                items: Array.isArray(turn.items) ? turn.items.slice(0, 2) : []
              }))
            }
          : page
      }
    })
    const open = async () => {
      const adapter = adapterFor(codex, { resumeThreadId: THREAD })
      try {
        await acquireReadyCodexForTest(adapter, {
          identity: {
            sessionId: SESSION,
            workspaceId: 'workspace-1',
            hostId: 'local',
            agent: 'codex',
            providerHandle: codexProviderHandle(THREAD)
          },
          fence: 1,
          spawnToken: 'recorded-fixture-child',
          events: c.deferred.sink
        })
        await c.deferred.drained()
      } finally {
        await adapter.closeAll()
      }
    }
    await open()
    expect(c.texts()).toEqual([
      'user:native',
      '(continued-outside)',
      'user:ask 1',
      'assistant:answer 1',
      'assistant:completed answer'
    ])
    expect(
      c.journal.snapshot().items.filter((item) => item.body.kind === 'tool-call')
    ).toHaveLength(1)
    expect(c.journal.item(agentJournalItemKey(detailIdentity))?.body).toMatchObject({
      state: 'completed'
    })
    const before = c.journal.cursor()
    await open()
    expect(c.journal.cursor()).toEqual(before)
    expect(fullReads).toBe(1)
    const hiddenTool = {
      type: 'commandExecution',
      id: 'older-tool',
      command: 'pwd',
      status: 'completed',
      aggregatedOutput: '/older',
      exitCode: 0
    }
    turns[0] = { ...first, items: [...(Array.isArray(first.items) ? first.items : []), hiddenTool] }
    await open()
    // An identical known summary supplies no discovery signal for unseen intermediate tools.
    expect(fullReads).toBe(1)
    expect(c.journal.cursor()).toEqual(before)
    turns.unshift(turn(0))
    turns.push(turn(3))
    await open()
    // The newly selected page also acquires its known sibling's full content.
    expect(fullReads).toBe(3)
    expect(
      c.journal.snapshot().items.filter((item) => item.body.kind === 'tool-call')
    ).toHaveLength(2)
    const acquired = c.journal.cursor()
    await open()
    expect(c.journal.cursor()).toEqual(acquired)
    // A lifecycle identity alone cannot discard newly supplied current-turn content.
    codex.routes['thread/resume'] = () => ({
      thread: {
        id: THREAD,
        historyMode: 'paginated',
        turns: [
          {
            ...current,
            items: [
              ...current.items,
              { type: 'agentMessage', id: 'tail', text: 'final missing tail' }
            ]
          }
        ]
      }
    })
    await open()
    expect(c.texts().at(-1)).toBe('assistant:final missing tail')
    await c.reopen()
    expect(c.texts().filter((text) => text === 'assistant:completed answer')).toHaveLength(1)
    expect(c.texts().at(-1)).toBe('assistant:final missing tail')
  })
}
