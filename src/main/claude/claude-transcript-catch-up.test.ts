// Real disk tail → isolated translator → deferred sink → on-disk journal contracts.
import { describe, expect, it, vi } from 'vitest'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import * as sessionFileResolver from '../native-chat/session-file-resolver'
import * as transcriptTail from './claude-transcript-tail'
import {
  isStructuredRewindTarget,
  structuredRewindCut
} from '../native-chat/agent-session-wire/structured-rewind-cut'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { readAgentSessionHistory } from '../native-chat/agent-session-wire/agent-session-history-page'
import { projectJournalBatch } from '../native-chat/agent-session-wire/agent-session-journal-batch'
import { replacePage, mergeItems } from '../../shared/structured-agent-session-history-state'
import { AgentJournalRenderItemSchema } from '../../shared/agent-session-journal-schemas'
import { projectStructuredItemToNativeChat } from '../../shared/structured-agent-session-projection'
import {
  SESSION,
  SID,
  at,
  prompt,
  reply,
  attachment,
  bookkeeping,
  chatTurn,
  outsideTurn,
  chat
} from './claude-transcript-catch-up-test-support'

describe('Claude chat catch-up', () => {
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
      const submissions = c.journal.snapshot().submissions
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
      const held = c.journal.snapshot().items
      expect(c.rows().filter((row) => row === 'user:follow up')).toHaveLength(1)
      expect(c.journal.item(key)?.turnScope).toEqual({ kind: 'unknown' })
      expect(isStructuredRewindTarget(c.journal, key)).toBe(false)
      expect(held.filter((row) => row.body.kind === 'turn')).toHaveLength(1)
      expect(await c.open('a1')).toBe(true)
      expect(c.journal.snapshot().items).toEqual(held)
      const reopened = await c.replay()
      expect(reopened.item(key)).toEqual(c.journal.item(key))
      expect(isStructuredRewindTarget(reopened, key)).toBe(false)
      const page = readAgentSessionHistory(reopened, { sessionId: SESSION, direction: 'tail' })
      const delta = reopened.readSince(cursor)
      if (!page.ok || !delta.ok) {
        throw new Error('history unavailable')
      }
      const batch = projectJournalBatch({
        rows: delta.rows,
        snapshot: reopened.snapshot(),
        afterSequence: cursor.sequence
      })
      if (!batch.ok) {
        throw new Error('batch unavailable')
      }
      const snapshotClient = replacePage(page.page, 1)
      const liveClient = mergeItems([], batch.batch.items, [])
      expect(snapshotClient.items.find((item) => item.itemId === key)).toEqual(c.journal.item(key))
      expect(liveClient.find((item) => item.itemId === key)).toEqual(c.journal.item(key))
      // The open wire schema used by older readers preserves the new scope and message content.
      expect(
        AgentJournalRenderItemSchema.parse(JSON.parse(JSON.stringify(c.journal.item(key))))
      ).toMatchObject({ turnScope: { kind: 'unknown' }, body: { role: 'user' } })

      await c.write([
        reply('a2', 'queued-row', 'msg_b', { type: 'text', text: 'follow up answer' }, 4),
        prompt('p3', 'a2', 'next request', 5),
        reply('a3', 'p3', 'msg_c', { type: 'text', text: 'next answer' }, 6)
      ])
      expect(await c.open('a1')).toBe(true)
      const items = c.journal.snapshot().items
      expect(c.journal.item(key)).toEqual(held.find((row) => row.itemId === key))
      const resumed = items.find((row) => row.body.kind === 'turn' && row.body.turnId === 'a2')
      expect(resumed?.body).toMatchObject({ userItemId: resumed?.itemId })
      const opener = agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'p3' })
      expect(isStructuredRewindTarget(c.journal, opener)).toBe(true)
      expect(c.journal.snapshot().submissions).toEqual(submissions)
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
      expect(c.journal.item(key)?.turnScope).toEqual({ kind: 'unknown' })
      expect((await c.replay()).item(key)?.turnScope).toEqual({ kind: 'unknown' })
    }
  )

  it('keeps outside message times and order without splitting queued work', async () => {
    const c = await chat()
    await c.live()
    await c.write([
      ...chatTurn,
      prompt('p2', 'a1', 'outside request', 3),
      reply(
        'a2',
        'p2',
        'msg_b',
        { type: 'tool_use', id: 'toolu_time', name: 'Read', input: {} },
        4
      ),
      {
        ...attachment('queued-row', 'a2'),
        timestamp: at(5),
        attachment: {
          type: 'queued_command',
          source_uuid: 'cmd-1',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
          prompt: 'follow up'
        }
      },
      reply('a3', 'queued-row', 'msg_c', { type: 'text', text: 'finished' }, 6),
      {
        ...prompt('r-time', 'a3', '', 7),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_time', content: 'done' }]
        }
      },
      {
        ...reply('a5', 'r-time', 'msg_missing', { type: 'text', text: 'no source time' }, 8),
        timestamp: undefined
      }
    ])
    expect(await c.open('a1')).toBe(true)
    const key = (uuid: string) =>
      agentJournalItemKey(
        uuid === 'toolu_time'
          ? { provider: 'orca', clientMessageId: `claude-tool:${SID}:${uuid}` }
          : { provider: 'claude', sessionId: SID, uuid }
      )
    const queued = c.journal.item(key('cmd-1'))
    expect(queued?.turnScope).toEqual(c.journal.item(key('toolu_time'))?.turnScope)
    expect(queued?.turnScope).toMatchObject({ kind: 'turn' })
    expect(c.journal.item(key('block:msg_c:0'))?.turnScope).toEqual(queued?.turnScope)
    expect(c.journal.snapshot().items.filter((row) => row.body.kind === 'turn')).toHaveLength(2)
    expect(isStructuredRewindTarget(c.journal, key('cmd-1'))).toBe(false)
    expect(isStructuredRewindTarget(c.journal, key('p2'))).toBe(true)
    const items = c.journal
      .snapshot()
      .items.filter((item) =>
        ['p2', 'toolu_time', 'cmd-1', 'block:msg_c:0', 'block:msg_missing:0'].some(
          (uuid) => item.itemId === key(uuid)
        )
      )
    expect(items.map((item) => [item.itemId, item.observedAt])).toEqual([
      [key('p2'), Date.parse(at(3))],
      [key('toolu_time'), Date.parse(at(4))],
      [key('cmd-1'), Date.parse(at(5))],
      [key('block:msg_c:0'), Date.parse(at(6))],
      [key('block:msg_missing:0'), 1_000]
    ])
    expect(items.map((item) => projectStructuredItemToNativeChat(item)?.timestamp)).toEqual(
      items.map((item) => item.observedAt)
    )
    expect(new Set(items.map((item) => item.sequence)).size).toBe(1)
    const imported = c.journal.snapshot().items
    expect(await c.open('a1')).toBe(true)
    expect(c.journal.snapshot().items).toEqual(imported)
    expect((await c.replay()).snapshot().items).toEqual(imported)
  })
  it.each([
    ['-work', '/work', false],
    ['-work-caf-', '/work/cafe\u0301', false],
    ['-old-work', '/moved-work', true]
  ] as const)(
    'uses the selected-home bucket, retaining moved-project fallback: %s',
    async (project, cwd, fallback) => {
      const c = await chat(project, cwd)
      await c.write([...chatTurn, ...outsideTurn])
      const resolve = vi.spyOn(sessionFileResolver, 'resolveSessionFilePath')
      expect(await c.open('a1')).toBe(true)
      expect(c.rows()).toContain('assistant:answer 2')
      expect(resolve).toHaveBeenCalledTimes(fallback ? 1 : 0)
      if (fallback) {
        expect(resolve).toHaveBeenCalledWith(
          'claude',
          SID,
          expect.objectContaining({ claudeProjectsDir: expect.any(String) }),
          expect.any(AbortSignal)
        )
      }
    }
  )

  it('never leaves a turn it imports running when its reply was already saved', async () => {
    // An update killed the chat after Claude saved its reply but before the prompt's echo.
    const c = await chat()
    await c.live({ interrupted: true })
    const saved = new Set(c.journal.snapshot().items.map((item) => item.itemId))
    await c.write([
      prompt('leaf', null, 'earlier request', 0),
      prompt('unechoed', 'leaf', 'ask 1', 1),
      reply('a1', 'unechoed', 'msg_a', { type: 'text', text: 'answer 1' }, 2)
    ])
    expect(await c.open('leaf')).toBe(true)
    const imported = c.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'turn' && !saved.has(item.itemId))
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
    const before = c.journal.snapshot().items
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
    const afterText = c.journal.item(text.itemId)!
    const afterTool = c.journal.item(tool.itemId)!
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
    expect(c.journal.item(turn.itemId)).toEqual(turn)
    expect(c.journal.item(thinking.itemId)).toEqual(thinking)
    expect(c.rows().some((row) => row.startsWith('(continued-outside'))).toBe(false)
    const completed = c.journal.snapshot().items
    expect(await c.open('boundary')).toBe(true)
    expect(c.journal.snapshot().items).toEqual(completed)
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
    const running = c.journal.snapshot().items.findLast((item) => item.body.kind === 'turn')
    expect(running?.body).toMatchObject({ state: 'running' })
    live.dispose()
  })

  it('cancels fallback discovery and cannot commit a late result', async () => {
    const c = await chat('-old-work', '/new-work')
    await c.write([...chatTurn, ...outsideTurn])
    const lookup = Promise.withResolvers<string | null>()
    const resolve = vi
      .spyOn(sessionFileResolver, 'resolveSessionFilePath')
      .mockReturnValueOnce(lookup.promise)
    expect(await c.open('a1', { timeoutMs: 5 })).toBe(false)
    expect(resolve.mock.calls[0]?.[3]?.aborted).toBe(true)
    lookup.resolve(null)
    await new Promise<void>((done) => setImmediate(done))
    expect(c.rows()).toEqual([])
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
    expect(c.journal.snapshot().submissions).toHaveLength(1)

    // Opening again, or from a leaf left before the chat's own streamed turn by a crash, adds nothing.
    await c.open('a1')
    await c.open('p1')
    expect(c.rows()).toEqual(caughtUp)
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('imports a later outside batch from the retained leaf without reusing its old divider', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    expect(await c.open('a1')).toBe(true)
    const before = c.rows()
    await c.write([
      prompt('p3', 'a3', 'ask 3', 7),
      reply('a4', 'p3', 'msg_d', { type: 'text', text: 'answer 3' }, 8)
    ])
    expect(await c.open('a1')).toBe(true)
    expect(c.rows()).toEqual([...before, '(continued-outside)', 'user:ask 3', 'assistant:answer 3'])
    const imported = c.journal.snapshot().items
    expect(await c.open('a1')).toBe(true)
    expect(c.journal.snapshot().items).toEqual(imported)
    expect(c.warn).not.toHaveBeenCalled()
  })

  // P known prompts and J reduced items grow independently; this ceiling retains the P×J cost.
  it.each([10, 100].flatMap((prompts) => [1_000, 10_000].map((items) => ({ prompts, items }))))(
    'bounds retained-leaf work for $prompts known prompts and $items journal items',
    async ({ prompts, items }) => {
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
      const canonical = c.journal.canonicalItemId(alias)
      expect(canonical).not.toBe(alias)
      const submissions = c.journal.snapshot().submissions
      await c.write(rows)
      expect(await c.open('saved-leaf')).toBe(true)
      expect(c.rows()).toEqual(expected)
      expect(c.journal.snapshot().submissions).toEqual(submissions)
      await c.journal.appendLifecycleBatch({
        settlementId: 'perf-padding',
        fence: 1,
        mutations: Array.from({ length: items - c.journal.snapshot().items.length }, (_, n) => ({
          kind: 'item' as const,
          identity: { provider: 'claude' as const, sessionId: SID, uuid: `padding${n}` },
          body: { kind: 'message' as const, role: 'assistant' as const, blocks: [] },
          turnScope: { kind: 'thread' as const }
        }))
      })
      const before = c.journal.snapshot()
      const itemCount = before.items.length
      expect(itemCount).toBe(items)
      let associationVisits = 0
      let viewVisits = 0
      const visitItems = c.journal.visitItems.bind(c.journal)
      const visitLinked = c.journal.visitItemsWithLinkage.bind(c.journal)
      vi.spyOn(c.journal, 'visitItems').mockImplementation((visit) =>
        visitItems((...args) => {
          associationVisits++
          visit(...args)
        })
      )
      vi.spyOn(c.journal, 'visitItemsWithLinkage').mockImplementation((visit) =>
        visitLinked((...args) => {
          viewVisits++
          visit(...args)
        })
      )
      c.journal.visitItems(() => {})
      c.journal.visitItemsWithLinkage(() => {})
      expect([associationVisits, viewVisits]).toEqual([itemCount, itemCount])
      associationVisits = viewVisits = 0
      const committed = vi.fn()
      c.journal.observeCommits(committed)
      const tail = vi.spyOn(transcriptTail, 'readClaudeTranscriptTail')
      expect(await c.open('saved-leaf')).toBe(true)
      expect(tail).toHaveBeenCalledOnce()
      expect(
        (await tail.mock.results[0].value)?.rows.filter((row) => row.type === 'user')
      ).toHaveLength(prompts)
      expect(c.journal.snapshot()).toEqual(before)
      expect(c.journal.canonicalItemId(alias)).toBe(canonical)
      expect(committed).not.toHaveBeenCalled()
      expect(c.warn).not.toHaveBeenCalled()
      expect(associationVisits).toBeLessThanOrEqual(prompts * itemCount)
      expect(viewVisits).toBeLessThanOrEqual(2 * itemCount)
      console.info('retained-leaf operation counts', {
        prompts,
        itemCount,
        associationVisits,
        viewVisits
      })
    }
  )

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
    const scope = c.journal
      .snapshot()
      .items.find(
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
    const before = c.journal.snapshot()
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
    const imported = c.journal.snapshot().items
    expect(await c.open('p1')).toBe(true)
    expect(c.journal.snapshot().items).toEqual(imported)
    expect(c.journal.snapshot().submissions).toEqual(before.submissions)
    for (const item of before.items) {
      expect(c.journal.item(item.itemId)).toEqual(item)
    }
    const unknown = agentJournalItemKey({
      provider: 'claude',
      sessionId: SID,
      uuid: 'unknown-input'
    })
    expect(c.journal.item(unknown)?.turnScope).toEqual({ kind: 'unknown' })
    expect(isStructuredRewindTarget(c.journal, unknown)).toBe(false)
    const answer = c.journal
      .snapshot()
      .items.find(
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

  it('marks turns that continue from an earlier message than the chat last showed', async () => {
    const c = await chat()
    await c.live()
    await c.write([
      ...chatTurn,
      prompt('p3', 'p1', 'ask 1, edited', 7),
      reply('a4', 'p3', 'msg_d', { type: 'text', text: 'answer 1, edited' }, 8)
    ])
    await c.open('a1')
    expect(c.rows().slice(2)).toEqual([
      '(continued-outside-rewound)',
      'user:ask 1, edited',
      'assistant:answer 1, edited'
    ])
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
