import {
  readTestJournalItems,
  readTestJournalSnapshot,
  readTestJournalSubmissions
} from '../native-chat/agent-session-journal/journal-observation.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'
import {
  isStructuredRewindTarget,
  structuredRewindCut
} from '../native-chat/agent-session-wire/rewind/structured-rewind-cut'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentSessionHistory } from '../native-chat/agent-session-wire/publication/history/agent-session-history-page'
import { projectJournalBatch } from '../native-chat/agent-session-wire/publication/history/agent-session-journal-batch'
import {
  replacePage,
  mergeItems
} from '../../shared/agent-session/view/structured-agent-session-history-state'
import { AgentJournalRenderItemSchema } from '../../shared/agent-session/journal/agent-session-journal-schemas'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { dispatchClaudeTurn } from './structured/claude-structured-dispatch'
import { claudePromptUuidForSubmission } from './structured/claude-structured-session-id'
import {
  childExited,
  sessionFor,
  userMessage
} from './structured/claude-structured-dispatch-test-support'
import {
  SESSION,
  SID,
  prompt,
  reply,
  attachment,
  bookkeeping,
  chatTurn,
  outsideTurn,
  chat
} from './claude-transcript-catch-up-test-support'
// Real disk tail → isolated translator → deferred sink → on-disk journal contracts.
import * as transcriptTail from './claude-transcript-tail'
import {
  withStructuredHistoryInvocation,
  type StructuredHistoryInvocationOwner
} from '../native-chat/agent-session-wire/acquisition/structured-agent-session-history-invocation'

describe('Claude chat catch-up', () => {
  it('revokes a queued catch-up on context activity without a journal write', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    const translator = createClaudeJournalTranslator({ sink: c.deferred.sink })
    const owner: StructuredHistoryInvocationOwner = {}
    const append = c.deferred.sink.tryAppendTransition!.bind(c.deferred.sink)
    vi.spyOn(c.deferred.sink, 'tryAppendTransition').mockImplementationOnce((transition) =>
      append({
        ...transition,
        beforeRun: () => {
          const allowed = transition.beforeRun?.() !== false
          translator.markContextActivity()
          return allowed
        }
      })
    )
    const before = await readTestJournalSnapshot(c.journal)
    try {
      const covered = await withStructuredHistoryInvocation(
        owner,
        new AbortController().signal,
        async (signal, revoke) => {
          const release = translator.subscribeContextActivity(revoke)
          try {
            return await c.open('a1', { signal })
          } finally {
            release()
          }
        }
      )
      expect(covered).toBe(false)
      expect(await readTestJournalSnapshot(c.journal)).toEqual(before)
      expect(await c.open('a1')).toBe(true)
      expect((await readTestJournalItems(c.journal)).length).toBeGreaterThan(before.items.length)
    } finally {
      translator.dispose()
    }
  })
  it.each([false, true])(
    'recognizes an unacknowledged local prompt; equal external input: %s',
    async (outside) => {
      const c = await chat()
      await c.live()
      const body = userMessage([{ type: 'text', text: 'same prompt' }])
      const clientMessageId = 'unacknowledged'
      await c.journal.appendSubmission({
        clientMessageId,
        body,
        fence: 1,
        payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body)
      })
      const send = vi.fn().mockResolvedValue(undefined)
      const session = sessionFor(send)
      session.providerSessionId = SID
      await dispatchClaudeTurn(session, { sessionId: SESSION, clientMessageId, body })
      const uuid = String(send.mock.calls[0]![0].uuid)
      childExited(session)
      await c.journal.resolveDispatch({
        clientMessageId,
        fence: 1,
        state: 'unknown',
        reason: 'provider_closed_before_acknowledgement'
      })
      const before = await readTestJournalSnapshot(c.journal)
      await c.journal.close()
      const reopened = await c.replay()
      c.deferred.bind({ journal: reopened, fence: 1, publish: () => {} })
      const queued = {
        ...attachment('queued', 'a1'),
        attachment: {
          type: 'queued_command',
          source_uuid: uuid,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
          prompt: 'same prompt'
        }
      }
      await c.write([
        ...chatTurn,
        outside ? queued : prompt(uuid, 'a1', 'same prompt', 3),
        reply(
          'recovered',
          outside ? 'queued' : uuid,
          'msg_recovered',
          { type: 'text', text: 'reply' },
          4
        ),
        ...(outside ? [prompt('external', 'recovered', 'same prompt', 5)] : [])
      ])
      expect(await c.open('a1')).toBe(true)
      const after = await readTestJournalSnapshot(reopened)
      expect(
        after.items
          .filter((item) => item.body.kind !== 'turn')
          .map((item) => (item.body.kind === 'message' ? item.body.role : item.body.kind))
      ).toEqual(['user', 'assistant', 'user', 'status', 'assistant', ...(outside ? ['user'] : [])])
      expect(after.submissions).toEqual(before.submissions)
      expect(await reopened.reads.receiptFor(clientMessageId)).toBeNull()
      const key = agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid })
      expect(await reopened.reads.canonicalItemId(key)).toBe(key)
      expect(
        structuredRewindCut(reopened, {
          itemId: agentJournalItemKey({ provider: 'orca', clientMessageId }),
          provider: 'claude',
          nativeId: SID
        })
      ).toBeNull()
      expect(await c.open('a1')).toBe(true)
      expect(await readTestJournalSnapshot(reopened)).toEqual(after)
      expect(await readTestJournalSnapshot(await c.replay())).toEqual(after)
      expect(c.warn).not.toHaveBeenCalled()
    }
  )

  it.each(['a1', 'missing-parent'])(
    'keeps an unresolved queued prompt visible without inventing a turn after %s',
    async (parent) => {
      const c = await chat()
      await c.live()
      await c.journal.appendSubmission({
        clientMessageId: 'new-native-send',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'new native request' }]
        },
        payloadFingerprint: 'new-native-send',
        handoverRecorded: true,
        fence: 1
      })
      await c.journal.resolveDispatch({
        clientMessageId: 'new-native-send',
        state: 'pending',
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const submissions = await readTestJournalSubmissions(c.journal)
      const cursor = c.journal.cursor()
      await c.write([
        ...chatTurn,
        {
          ...attachment('queued-row', parent),
          attachment: {
            type: 'queued_command',
            source_uuid: 'cmd-1',
            commandMode: 'prompt',
            origin: { kind: 'human' },
            humanTurn: true,
            prompt: 'follow up'
          }
        }
      ])
      const key = agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'cmd-1' })
      expect(await c.open('a1')).toBe(true)
      const held = await readTestJournalItems(c.journal)
      expect(c.rows().filter((row) => row === 'user:follow up')).toHaveLength(1)
      expect((await c.journal.reads.item(key))?.turnScope).toEqual({ kind: 'unknown' })
      expect(isStructuredRewindTarget(c.journal, key)).toBe(false)
      expect(held.filter((row) => row.body.kind === 'turn')).toHaveLength(1)
      expect(await c.open('a1')).toBe(true)
      expect(await readTestJournalItems(c.journal)).toEqual(held)
      const beforeReplay = await c.journal.reads.item(key)
      const reopened = await c.replay()
      expect(await reopened.reads.item(key)).toEqual(beforeReplay)
      expect(isStructuredRewindTarget(reopened, key)).toBe(false)
      const page = readAgentSessionHistory(reopened, { sessionId: SESSION, direction: 'tail' })
      const delta = reopened.readSince(cursor)
      if (!page.ok || !delta.ok) {
        throw new Error('history unavailable')
      }
      const batch = projectJournalBatch({
        rows: delta.rows,
        snapshot: await readTestJournalSnapshot(reopened),
        afterSequence: cursor.sequence
      })
      if (!batch.ok) {
        throw new Error('batch unavailable')
      }
      const snapshotClient = replacePage(page.page, 1)
      const liveClient = mergeItems([], batch.batch.items, [])
      expect(snapshotClient.items.find((item) => item.itemId === key)).toEqual(
        await c.journal.reads.item(key)
      )
      expect(liveClient.find((item) => item.itemId === key)).toEqual(
        await c.journal.reads.item(key)
      )
      // The open wire schema used by older readers preserves the new scope and message content.
      expect(
        AgentJournalRenderItemSchema.parse(
          JSON.parse(JSON.stringify(await c.journal.reads.item(key)))
        )
      ).toMatchObject({ turnScope: { kind: 'unknown' }, body: { role: 'user' } })

      await c.write([
        reply('a2', 'queued-row', 'msg_b', { type: 'text', text: 'follow up answer' }, 4),
        prompt('p3', 'a2', 'next request', 5),
        reply('a3', 'p3', 'msg_c', { type: 'text', text: 'next answer' }, 6)
      ])
      expect(await c.open('a1')).toBe(true)
      const items = await readTestJournalItems(c.journal)
      expect(await c.journal.reads.item(key)).toEqual(held.find((row) => row.itemId === key))
      const resumed = items.find((row) => row.body.kind === 'turn' && row.body.turnId === 'a2')
      expect(resumed?.body).toMatchObject({ userItemId: resumed?.itemId })
      const opener = agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'p3' })
      expect(isStructuredRewindTarget(c.journal, opener)).toBe(true)
      expect(await readTestJournalSubmissions(c.journal)).toEqual(submissions)
      expect(c.rows().filter((row) => row === 'user:follow up')).toHaveLength(1)
      expect(c.warn).not.toHaveBeenCalled()
      const cut = structuredRewindCut(c.journal, {
        itemId: opener,
        provider: 'claude',
        nativeId: SID
      })
      if (!cut) {
        throw new Error('ordinary rewind unavailable')
      }
      await c.journal.replaceEpochItems('handle_forked', 1, cut.kept)
      expect((await c.journal.reads.item(key))?.turnScope).toEqual({ kind: 'unknown' })
      expect((await (await c.replay()).reads.item(key))?.turnScope).toEqual({ kind: 'unknown' })
    }
  )

  it.each([
    ['-work', '/work'],
    ['-work-caf-', '/work/cafe\u0301'],
    ['-old-work', '/moved-work']
  ] as const)(
    'uses the selected-home bucket, retaining moved-project fallback: %s',
    async (project, cwd) => {
      const c = await chat(project, cwd)
      await c.write([...chatTurn, ...outsideTurn])
      expect(await c.open('a1')).toBe(true)
      expect(c.rows()).toContain('assistant:answer 2')
    }
  )

  it('never leaves a turn it imports running when its reply was already saved', async () => {
    // An update killed the chat after Claude saved its reply but before the prompt's echo.
    const c = await chat()
    await c.live({ interrupted: true })
    const saved = new Set((await readTestJournalItems(c.journal)).map((item) => item.itemId))
    await c.write([
      prompt('leaf', null, 'earlier request', 0),
      prompt('unechoed', 'leaf', 'ask 1', 1),
      reply('a1', 'unechoed', 'msg_a', { type: 'text', text: 'answer 1' }, 2)
    ])
    expect(await c.open('leaf')).toBe(true)
    const imported = (await readTestJournalItems(c.journal)).filter(
      (item) => item.body.kind === 'turn' && !saved.has(item.itemId)
    )
    expect(imported).toHaveLength(1)
    // It ends where it opened: in the thread, not inside the saved turn its reply matched.
    expect(imported[0]).toMatchObject({
      body: { state: 'completed' },
      turnScope: { kind: 'thread' }
    })
  })

  it('completes interrupted text and a result-only tool once at their original positions', async () => {
    const c = await chat()
    await c.live({
      interrupted: true,
      tool: true,
      text: 'unfinished, differently normalized',
      thinking: 'retained thought'
    })
    const before = await readTestJournalItems(c.journal)
    const tool = before.find((item) => item.body.kind === 'tool-call')!
    const text = before.find(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )!
    const turn = before.find((item) => item.body.kind === 'turn')!
    const thinking = before.find(
      (item) => item.body.kind === 'message' && item.body.role === 'reasoning'
    )!
    await c.write([
      prompt('boundary', null, 'saved before crash', 1),
      reply('a1', 'boundary', 'msg_a', { type: 'text', text: 'final answer, normalized' }, 2),
      reply('thinking-final', 'a1', 'msg_thought', { type: 'thinking', thinking: '' }, 3),
      { ...outsideTurn[4], parentUuid: 'thinking-final' }
    ])
    expect(await c.open('boundary')).toBe(true)
    const afterText = (await c.journal.reads.item(text.itemId))!
    const afterTool = (await c.journal.reads.item(tool.itemId))!
    expect(afterText).toMatchObject({
      sequence: text.sequence,
      observedAt: text.observedAt,
      turnScope: text.turnScope,
      body: { blocks: [{ type: 'text', text: 'final answer, normalized' }] }
    })
    expect(afterTool).toMatchObject({
      sequence: tool.sequence,
      observedAt: tool.observedAt,
      turnScope: tool.turnScope,
      body: {
        name: 'Read',
        input: { path: 'original' },
        state: 'completed',
        output: { head: 'hello' }
      }
    })
    expect(await c.journal.reads.item(turn.itemId)).toEqual(turn)
    expect(await c.journal.reads.item(thinking.itemId)).toEqual(thinking)
    expect(c.rows().some((row) => row.startsWith('(continued-outside'))).toBe(false)
    const completed = await readTestJournalItems(c.journal)
    expect(await c.open('boundary')).toBe(true)
    expect(await readTestJournalItems(c.journal)).toEqual(completed)
  })

  it('does not place historical lifecycle after live work that arrives during its read', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    const read = transcriptTail.readClaudeTranscriptTail
    const live = createClaudeJournalTranslator({ sink: c.deferred.sink })
    vi.spyOn(transcriptTail, 'readClaudeTranscriptTail').mockImplementationOnce(async (input) => {
      const tail = await read(input)
      live.handle({
        type: 'message',
        sessionId: SESSION,
        message: {
          type: 'stream_event',
          uuid: 'wake',
          session_id: SID,
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'live-wake' } }
        }
      })
      return tail
    })
    expect(await c.open('a1')).toBe(false)
    expect(c.rows()).not.toContain('user:ask 2')
    const running = (await readTestJournalItems(c.journal)).findLast(
      (item) => item.body.kind === 'turn'
    )
    expect(running?.body).toMatchObject({ state: 'running' })
    live.dispose()
  })

  it('shows the turns made outside the chat once, in order, under one divider', async () => {
    const c = await chat()
    await c.live()
    await c.write(chatTurn)
    const shown = c.rows()
    expect(shown).toEqual(['user:ask 1', 'assistant:answer 1'])

    await c.open('a1')
    expect(c.rows()).toEqual(shown)

    await c.write(outsideTurn)
    await c.open('a1')
    const caughtUp = [
      ...shown,
      '(continued-outside)',
      'user:ask 2',
      'tool:Read:completed',
      'assistant:answer 2'
    ]
    expect(c.rows()).toEqual(caughtUp)
    expect(await readTestJournalSubmissions(c.journal)).toHaveLength(1)

    // Opening again, or from a leaf left before the chat's own streamed turn by a crash, adds nothing.
    await c.open('a1')
    await c.open('p1')
    expect(c.rows()).toEqual(caughtUp)
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('keeps retained aliases and unacknowledged queued prompts deduplicated', async () => {
    const prompts = 100,
      items = 10_000
    const c = await chat()
    await c.live()
    const expected = [...c.rows(), '(continued-outside)']
    const rows: Record<string, unknown>[] = [
      reply('saved-leaf', 'earlier-prompt', 'msg_saved', { type: 'text', text: 'earlier' }, 0),
      prompt('p1', 'saved-leaf', 'ask 1', 1),
      ...chatTurn.slice(1)
    ]
    for (let n = 1; n < prompts; n++) {
      rows.push(
        prompt(`outside-p${n}`, n === 1 ? 'a1' : `outside-a${n - 1}`, `ask ${n}`, n * 2 + 1),
        reply(
          `outside-a${n}`,
          `outside-p${n}`,
          `msg_outside${n}`,
          { type: 'text', text: `answer ${n}` },
          n * 2 + 2
        )
      )
      expected.push(`user:ask ${n}`, `assistant:answer ${n}`)
    }
    const alias = agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'p1' })
    const canonical = await c.journal.reads.canonicalItemId(alias)
    expect(canonical).not.toBe(alias)
    const submissions = await readTestJournalSubmissions(c.journal)
    await c.write(rows)
    expect(await c.open('saved-leaf')).toBe(true)
    expect(c.rows()).toEqual(expected)
    expect(await readTestJournalSubmissions(c.journal)).toEqual(submissions)
    await c.journal.appendLifecycleBatch({
      settlementId: 'perf-padding',
      fence: 1,
      mutations: Array.from(
        { length: items - (await readTestJournalItems(c.journal)).length },
        (_, n) => ({
          kind: 'item' as const,
          identity: { provider: 'orca' as const, clientMessageId: `padding${n}` },
          body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
          turnScope: { kind: 'thread' as const }
        })
      )
    })
    for (let n = 0; n < prompts; n++) {
      const key = agentJournalItemKey({ provider: 'orca', clientMessageId: `padding${n}` })
      await c.write([
        {
          ...attachment(`queued${n}`, n ? `queued${n - 1}` : `outside-a${prompts - 1}`),
          attachment: {
            type: 'queued_command',
            source_uuid: claudePromptUuidForSubmission(SESSION, key),
            commandMode: 'prompt',
            prompt: 'local'
          }
        }
      ])
    }
    const before = await readTestJournalSnapshot(c.journal)
    const itemCount = before.items.length
    expect(itemCount).toBe(items)
    expect(await c.open('saved-leaf')).toBe(true)
    expect(await readTestJournalSnapshot(c.journal)).toEqual(before)
    expect(await c.journal.reads.canonicalItemId(alias)).toBe(canonical)
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('clears closed scope and restores only a saved queued prompt without settling delivery', async () => {
    const c = await chat()
    await c.live()
    await c.journal.appendSubmission({
      clientMessageId: 'queued-send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'follow up' }] },
      payloadFingerprint: 'queued-send',
      handoverRecorded: true,
      fence: 1
    })
    const scope = (await readTestJournalItems(c.journal)).find(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )?.turnScope
    if (!scope || scope.kind !== 'turn') {
      throw new Error('missing native turn')
    }
    await c.journal.resolveDispatch({
      clientMessageId: 'queued-send',
      state: 'pending',
      turnScope: scope,
      fence: 1
    })
    await c.journal.resolveDispatch({
      clientMessageId: 'queued-send',
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: SID, uuid: 'cmd-1' },
      fence: 1
    })
    const before = await readTestJournalSnapshot(c.journal)
    const end = (uuid: string, parentUuid: string) => ({
      type: 'system',
      subtype: 'turn_duration',
      sessionId: SID,
      uuid,
      parentUuid,
      timestamp: 'malformed'
    })
    await c.write([
      ...chatTurn,
      end('saved-end', 'a1'),
      {
        ...attachment('unknown-row', 'saved-end'),
        attachment: {
          type: 'queued_command',
          source_uuid: 'unknown-input',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
          prompt: 'unproved input'
        }
      },
      {
        ...attachment('queued-row', 'unknown-row'),
        attachment: {
          type: 'queued_command',
          source_uuid: 'cmd-1',
          delivery_id: 'delivery-1',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
          prompt: 'follow up'
        }
      },
      reply('a2', 'queued-row', 'msg_b', { type: 'text', text: 'follow up answer' }, 3),
      end('continued-end', 'a2'),
      reply('wake', 'continued-end', 'msg_wake', { type: 'text', text: 'background' }, 4),
      prompt('next', 'wake', 'next request', 5),
      reply('next-answer', 'next', 'msg_next', { type: 'text', text: 'next answer' }, 6)
    ])
    expect(await c.open('p1')).toBe(true)
    expect(c.rows()).toEqual([
      'user:ask 1',
      'assistant:answer 1',
      'user:follow up',
      '(continued-outside)',
      'user:unproved input',
      'assistant:follow up answer',
      'assistant:background',
      'user:next request',
      'assistant:next answer'
    ])
    const imported = await readTestJournalItems(c.journal)
    expect(await c.open('p1')).toBe(true)
    expect(await readTestJournalItems(c.journal)).toEqual(imported)
    expect(await readTestJournalSubmissions(c.journal)).toEqual(before.submissions)
    for (const item of before.items) {
      expect(await c.journal.reads.item(item.itemId)).toEqual(item)
    }
    const unknown = agentJournalItemKey({
      provider: 'claude',
      sessionId: SID,
      uuid: 'unknown-input'
    })
    expect((await c.journal.reads.item(unknown))?.turnScope).toEqual({ kind: 'unknown' })
    expect(isStructuredRewindTarget(c.journal, unknown)).toBe(false)
    const answer = (await readTestJournalItems(c.journal)).find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.role === 'assistant' &&
        item.itemId !==
          agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'block:msg_a:0' })
    )
    expect(answer?.turnScope).toEqual(scope)
    const turns = imported.filter((item) => item.body.kind === 'turn')
    expect(turns).toHaveLength(3)
    const wake = turns.find((item) => item.body.kind === 'turn' && item.body.turnId === 'wake')!
    expect(wake.body).toMatchObject({ userItemId: wake.itemId })
    expect(turns.some((item) => item.body.kind === 'turn' && item.body.turnId === 'next')).toBe(
      true
    )
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('reads an outside reply that spans many read chunks whole', async () => {
    const c = await chat()
    await c.live()
    const answer = `${'outside answer paragraph\n'.repeat(12_000)}END`
    await c.write([
      ...chatTurn,
      prompt('p5', 'a1', 'ask long', 9),
      reply('a5', 'p5', 'msg_e', { type: 'text', text: answer }, 10),
      ...bookkeeping
    ])
    await c.open('a1')
    expect(c.rows().slice(2)).toEqual([
      '(continued-outside)',
      'user:ask long',
      `assistant:${answer}`
    ])
  })

  it('opens normally when the saved leaf is not in the transcript', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    await c.open('missing')
    expect(c.rows()).toEqual(['user:ask 1', 'assistant:answer 1'])
    expect(c.warn).toHaveBeenCalledWith(
      'Claude chat did not catch up on turns made outside it',
      expect.objectContaining({ reason: 'leaf-not-in-tail' })
    )
  })
})
