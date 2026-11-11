import {
  readTestJournalItems,
  readTestJournalSnapshot,
  readTestJournalSubmissions
} from '../native-chat/agent-session-journal/journal-observation.test-support'
import './claude-conversation-worker.test-fixture'

import { describe, expect, it, vi } from 'vitest'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { claudePromptUuidForSubmission } from './structured/claude-structured-session-id'
import {
  SESSION,
  SID,
  chatTurn,
  outsideTurn,
  prompt,
  reply,
  attachment,
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
    expect(await c.rows()).not.toContain('user:ask 2')
    const running = (await readTestJournalItems(c.journal)).findLast(
      (item) => item.body.kind === 'turn'
    )
    expect(running?.body).toMatchObject({ state: 'running' })
    live.dispose()
  })

  it('keeps retained aliases and unacknowledged queued prompts deduplicated', async () => {
    const prompts = 100,
      items = 10_000
    const c = await chat()
    await c.live()
    const expected = [...(await c.rows()), '(continued-outside)']
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
    expect(await c.rows()).toEqual(expected)
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
})
