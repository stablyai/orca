import { expect, it, vi } from 'vitest'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { nativeChatTurnMembership } from '../../shared/native-chat-turn-membership'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import { journalPayload } from '../native-chat/agent-session-journal/journal-payload-bounds'

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  chat as catchUpChat,
  codexWith as catchUpCodexWith,
  turn as catchUpTurn
} from './codex-structured-thread-catch-up.test'

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'

export function registerCodexHistoryVariantsTests(input: {
  codexWith: typeof catchUpCodexWith
  chat: typeof catchUpChat
  turn: typeof catchUpTurn
  sessionId: string
  threadId: string
}): void {
  const { chat, turn, sessionId: SESSION, threadId: THREAD } = input
  it('admits independent large source and transaction domains and diagnoses real workspace and transaction overflow', async () => {
    const c = await chat({ now: 1_000 })
    const output = 'x'.repeat(9 * 1024 * 1024)
    const large = {
      ...turn(1),
      items: [
        {
          type: 'commandExecution',
          id: 'large',
          command: 'cat output',
          status: 'completed',
          aggregatedOutput: output
        }
      ]
    }
    await c.open([large], {
      returnedTurns: [
        {
          ...large,
          status: 'inProgress',
          completedAt: undefined,
          items: [
            {
              type: 'commandExecution',
              id: 'large',
              command: 'cat output',
              status: 'inProgress',
              aggregatedOutput: 'z'.repeat(9 * 1024 * 1024)
            }
          ]
        }
      ]
    })
    expect(
      c.journal.snapshot().items.find(({ body }) => body.kind === 'tool-call')?.body
    ).toMatchObject({ output: journalPayload(output) })
    const snapshot = c.journal.snapshot()
    await c.reopen()
    const serialize = vi.spyOn(JSON, 'stringify')
    await c.open([], { paginate: false, returnedTurns: [large] })
    // The saved body is borrowed; measuring it is not a second serialization of its output.
    expect(
      serialize.mock.calls.some(([value]) => {
        if (typeof value === 'string') {
          return value.length > 8 * 1024 * 1024
        }
        if (typeof value !== 'object' || value === null) {
          return false
        }
        return (
          ('aggregatedOutput' in value && value.aggregatedOutput === output) ||
          ('output' in value &&
            value.output !== null &&
            typeof value.output === 'object' &&
            'head' in value.output &&
            value.output.head === output)
        )
      })
    ).toBe(false)
    serialize.mockRestore()
    expect(c.journal.snapshot()).toEqual(snapshot)
    const warnings = vi.fn()
    const logger = { warn: warnings, info: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const huge = {
      ...turn(2),
      items: [
        {
          type: 'commandExecution',
          id: 'huge',
          command: 'cat huge',
          status: 'completed',
          aggregatedOutput: 'y'.repeat(17 * 1024 * 1024)
        }
      ]
    }
    await c.open([], { paginate: false, returnedTurns: [huge], logger })
    expect(c.journal.snapshot()).toEqual(snapshot)
    expect(
      warnings.mock.calls.some(
        ([, fields]) =>
          fields.error instanceof Error && fields.error.message === 'history-workspace-too-large'
      )
    ).toBe(true)
    warnings.mockClear()
    await c.open([], {
      paginate: false,
      returnedTurns: [
        { ...large, id: 'turn-2' },
        { ...large, id: 'turn-3' }
      ],
      logger
    })
    expect(c.journal.snapshot()).toEqual(snapshot)
    expect(
      warnings.mock.calls.some(
        ([, fields]) => fields.error instanceof Error && fields.error.message === 'too-large'
      )
    ).toBe(true)
  })

  it('checks a retained omitted parent exactly once and refuses a real queued revision without losing the writer', async () => {
    const c = await chat({ now: 1_000 })
    const parent = {
      provider: 'orca' as const,
      clientMessageId: `codex-history-item:${JSON.stringify([1, THREAD, 'turn-1', 'parent'])}`
    }
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: [
            {
              type: 'commandExecution',
              id: 'parent',
              command: 'pwd',
              status: 'completed',
              aggregatedOutput: 'first'
            }
          ]
        },
        turn(2)
      ]
    })
    const old = c.journal.item(agentJournalItemKey(parent))
    if (old?.body.kind !== 'tool-call') {
      throw new Error('missing saved parent')
    }
    const body = old.body
    const append = c.deferred.sink.tryAppendTransition?.bind(c.deferred.sink)
    if (!append) {
      throw new Error('missing transition')
    }
    const calls = vi
      .spyOn(c.deferred.sink, 'tryAppendTransition')
      .mockImplementationOnce((transition) => {
        c.deferred.sink.appendItem(
          parent,
          { ...body, output: journalPayload('concurrent writer') },
          { lifecycle: true, turnScope: old.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE }
        )
        return append(transition)
      })
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: [
            { type: 'plan', id: 'child', parentCallId: 'parent', text: 'must fail stale parent' }
          ]
        }
      ]
    })
    expect(
      c.journal
        .snapshot()
        .items.some(({ body }) => body.kind === 'status' && body.text === 'must fail stale parent')
    ).toBe(false)
    expect(c.journal.item(old.itemId)?.body).toMatchObject({
      output: journalPayload('concurrent writer')
    })
    // Execute the captured real resolver against the now-current journal: stale checked dependency rejects the whole plan.
    const settlement = calls.mock.calls[0]?.[0].steps.find((step) => step.kind === 'settlement')
    expect(settlement?.kind).toBe('settlement')
    if (settlement?.kind === 'settlement') {
      expect(settlement.resolve(c.journal)).toEqual([])
    }
  })

  it('keeps source timing and finality independent of saved lifecycle and preserves validated group order', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([], { paginate: false, returnedTurns: [turn(1)] })
    const lifecycle = c.journal.item(
      agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, 'turn-1'))
    )
    const initial = {
      ...turn(1),
      status: undefined,
      completedAt: undefined,
      items: [
        { type: 'plan', id: 'null-time', completedAtMs: null, text: 'partial null' },
        { type: 'plan', id: 'zero-time', completedAtMs: 0, text: 'partial zero' },
        { type: 'plan', id: 'absent-time', text: 'partial absent' }
      ]
    }
    await c.open(
      [
        {
          ...initial,
          items: [
            { type: 'plan', id: 'null-time', completedAtMs: 20, text: 'final null' },
            { type: 'plan', id: 'zero-time', completedAtMs: 20, text: 'final zero' },
            { type: 'plan', id: 'absent-time', text: 'rewritten provisional' }
          ]
        },
        turn(2),
        turn(3),
        turn(4)
      ],
      {
        returnedTurns: [
          initial,
          turn(99),
          {
            ...turn(2),
            status: 'inProgress',
            completedAt: undefined,
            items: [{ type: 'userMessage', id: 'old-u', text: 'ask 2' }]
          }
        ]
      }
    )
    expect(c.journal.item(lifecycle?.itemId ?? '')).toEqual(lifecycle)
    const bodies = c.journal.snapshot().items.map(({ body }) => body)
    for (const text of ['final null', 'final zero', 'rewritten provisional']) {
      expect(bodies).toContainEqual(expect.objectContaining({ kind: 'status', text }))
    }
    expect(c.texts().filter((text) => !text.startsWith('('))).toEqual([
      'user:ask 1',
      'assistant:answer 1',
      'user:ask 2',
      'assistant:answer 2',
      'user:ask 3',
      'assistant:answer 3',
      'user:ask 4',
      'assistant:answer 4',
      'user:ask 99',
      'assistant:answer 99'
    ])
    await c.reopen()
    expect(c.journal.item(lifecycle?.itemId ?? '')).toEqual(lifecycle)
  })

  it('projects supported result enrichment once and refuses contradictory final copies locally', async () => {
    const c = await chat({ now: 1_000 })
    const helpers = new CodexSubagentExecutions()
    const initial = {
      ...turn(1),
      status: 'inProgress',
      completedAt: undefined,
      items: [
        { type: 'fileChange', id: 'patch', changes: [], status: 'inProgress' },
        { type: 'webSearch', id: 'web', query: 'orca' },
        { type: 'imageGeneration', id: 'image', status: 'inProgress' },
        { type: 'imageView', id: 'view', path: '/input.png' },
        {
          type: 'collabAgentToolCall',
          id: 'spawn',
          tool: 'spawnAgent',
          prompt: 'Review changes',
          status: 'inProgress'
        },
        { type: 'plan', id: 'plan', text: 'Tentative approach' },
        { type: 'reasoning', id: 'reason', summary: [{ text: 'Tentative reasoning' }] },
        { type: 'contextCompaction', id: 'compact-1' }
      ]
    }
    const final = {
      ...turn(1),
      items: [
        {
          type: 'fileChange',
          id: 'patch',
          status: 'completed',
          changes: [{ path: 'a.ts', diff: '+actual patch' }]
        },
        {
          type: 'webSearch',
          id: 'web',
          action: { type: 'search', query: 'orca' },
          results: [{ title: 'Orca', url: 'https://orca.dev' }]
        },
        { type: 'imageGeneration', id: 'image', status: 'completed', savedPath: '/result.png' },
        { type: 'imageView', id: 'view', path: '/input.png' },
        {
          type: 'collabAgentToolCall',
          id: 'spawn',
          tool: 'spawnAgent',
          prompt: 'Review changes',
          status: 'completed',
          receiverThreadIds: ['helper'],
          agentsStates: { helper: { status: 'running' } }
        },
        { type: 'plan', id: 'plan', text: 'A different final plan' },
        { type: 'reasoning', id: 'reason', summary: [{ text: 'A different final reason' }] },
        { type: 'contextCompaction', id: 'compact-2' }
      ]
    }
    await c.open([final], { returnedTurns: [initial], subagentExecutions: helpers })
    const bodies = c.journal.snapshot().items.map(({ body }) => body)
    expect(bodies).toContainEqual({
      kind: 'diff',
      path: 'a.ts',
      patch: journalPayload('+actual patch')
    })
    expect(bodies).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        name: 'web_search',
        state: 'completed',
        webSearchResults: [{ title: 'Orca', url: 'https://orca.dev' }]
      })
    )
    expect(bodies).toContainEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Generated image' },
        { type: 'image-ref', path: '/result.png' }
      ]
    })
    expect(bodies).toContainEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Viewed image' },
        { type: 'image-ref', path: '/input.png' }
      ]
    })
    expect(bodies).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        name: 'spawn_agent',
        input: expect.objectContaining({ description: 'Review changes', prompt: 'Review changes' }),
        state: 'completed',
        output: journalPayload('Spawned')
      })
    )
    expect(c.texts()).toContain('reasoning:A different final reason')
    expect(bodies).toContainEqual({
      kind: 'status',
      presentation: 'plan-document',
      text: 'A different final plan'
    })
    expect(
      bodies.filter((body) => body.kind === 'status' && body.presentation === 'compaction')
    ).toHaveLength(1)
    expect(helpers.label('helper')).toBe('Review changes')
    const saved = c.journal.snapshot()
    await c.reopen()
    expect(c.journal.snapshot()).toEqual(saved)

    const contradictory = {
      ...turn(2),
      items: [
        { type: 'agentMessage', id: 'a', text: 'First final' },
        {
          type: 'commandExecution',
          id: 'cmd',
          command: 'pwd',
          cwd: '',
          status: 'completed',
          aggregatedOutput: 'first output',
          completedAt: 10
        }
      ]
    }
    await c.open(
      [
        {
          ...contradictory,
          completedAt: 2_000_000_000,
          items: [
            { type: 'agentMessage', id: 'renumbered', text: 'Conflicting final' },
            {
              type: 'commandExecution',
              id: 'cmd',
              command: 'pwd',
              cwd: '',
              status: 'completed',
              aggregatedOutput: 'conflicting output',
              completedAt: 20
            },
            {
              type: 'agentMessage',
              id: 'independent',
              parentToolCallId: 'cmd',
              text: 'Independent good'
            }
          ]
        }
      ],
      { returnedTurns: [contradictory] }
    )
    expect(c.texts().slice(-2)).toEqual(['assistant:First final', 'assistant:Independent good'])
    expect(c.journal.snapshot().items.map(({ body }) => body)).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        callId: 'cmd',
        output: journalPayload('first output')
      })
    )
  })

  it('retains good observations, pre-filter message slots and exact proof around local collisions', async () => {
    const c = await chat({ now: 1_000 })
    const helpers = new CodexSubagentExecutions()
    const initial = {
      ...turn(1),
      status: 'inProgress',
      completedAt: undefined,
      items: [
        { type: 'futureItem', id: 'shadow' },
        { type: 'agentMessage', text: 'malformed slot' },
        { type: 'userMessage', id: 'u-old', text: 'Original question' },
        { type: 'agentMessage', id: 'a-old', text: 'Partial' },
        {
          type: 'commandExecution',
          id: 'call',
          command: 'pwd',
          cwd: '/workspace',
          status: 'inProgress'
        }
      ]
    }
    const final = {
      ...turn(1),
      items: [
        { type: 'agentMessage', text: 'malformed slot' },
        { type: 'userMessage', id: 'u-new', text: 'Collision question' },
        { type: 'agentMessage', id: 'a-new', text: 'Independent final' },
        {
          type: 'commandExecution',
          id: 'call',
          command: 'rm important',
          cwd: '/workspace',
          status: 'completed',
          aggregatedOutput: 'untrusted'
        },
        {
          type: 'collabAgentToolCall',
          id: 'bad-helper',
          parentCallId: 'call',
          tool: 'spawnAgent',
          prompt: 'Wrong invocation',
          receiverThreadIds: ['wrong-helper'],
          status: 'completed'
        },
        {
          type: 'agentMessage',
          id: 'bad-result',
          parentToolCallId: 'bad-helper',
          text: 'Wrong dependent'
        },
        { type: 'agentMessage', id: 'good', text: 'Good after refused slot' },
        {
          type: 'commandExecution',
          id: 'shadow',
          command: 'echo good',
          status: 'completed',
          aggregatedOutput: 'good'
        }
      ]
    }
    await c.journal.appendSubmission({
      clientMessageId: 'proof',
      payloadFingerprint: 'original',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Captured original' }]
      },
      fence: 1,
      handoverRecorded: true
    })
    const proof = {
      ...turn(3),
      items: [
        { type: 'userMessage', id: 'proof-row', clientId: 'proof', text: 'Provider rendering' },
        { type: 'agentMessage', id: 'answer', text: 'Proof sibling' }
      ]
    }
    const receipts: string[] = []
    await c.open([final, turn(2), proof], {
      returnedTurns: [initial],
      subagentExecutions: helpers,
      onReceipt: async (id, providerIdentity) => {
        receipts.push(id)
        await c.journal.acceptLate({
          clientMessageId: id,
          providerIdentity,
          state: 'accepted',
          fence: 1
        })
      }
    })
    expect(c.texts().filter((text) => !text.startsWith('('))).toEqual([
      'user:Captured original',
      'user:Original question',
      'assistant:Independent final',
      'assistant:Good after refused slot',
      'user:ask 2',
      'assistant:answer 2',
      'assistant:Proof sibling'
    ])
    expect(receipts).toEqual(['proof'])
    expect(c.journal.submission('proof')?.dispatchState).toBe('accepted')
    expect(helpers.find('wrong-helper')).toBeUndefined()
    const row = (ordinal: number) =>
      c.journal.item(
        agentJournalItemKey({ provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal })
      )
    expect(row(0)).toBeNull()
    expect(row(1)?.body).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'Original question' }]
    })
    expect(row(3)).toBeNull()
    expect(row(4)?.body).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Good after refused slot' }]
    })
    expect(
      c.journal
        .snapshot()
        .items.filter(({ body }) => body.kind === 'tool-call')
        .map(({ body }) => body)
    ).toEqual([
      expect.objectContaining({ input: { command: 'pwd', cwd: '/workspace' }, state: 'running' }),
      expect.objectContaining({
        input: { command: 'echo good', cwd: null },
        state: 'completed',
        output: journalPayload('good')
      })
    ])
    const saved = c.journal.snapshot()
    await c.reopen()
    expect(c.journal.snapshot()).toEqual(saved)
    expect(c.journal.receiptFor('proof')).not.toBeNull()
  })

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'enriches a saved unknown verdict with %s while conserving settled anchors and context',
    async (status) => {
      const c = await chat({ now: 1_000 })
      const initial = { ...turn(1), status: 'inProgress', completedAt: undefined }
      await c.open([], { returnedTurns: [initial], paginate: false })
      const identity = codexTurnLifecycleIdentity(SESSION, 'turn-1')
      const key = agentJournalItemKey(identity)
      const old = c.journal.item(key)
      if (old?.body.kind !== 'turn') {
        throw new Error('missing saved lifecycle')
      }
      const contextUsage = { window: { tokens: 100_000, capturedAt: 900 } }
      await c.journal.appendItem(
        identity,
        { ...old.body, contextUsage, requestedAt: 500 },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      const original = c.journal.item(
        agentJournalItemKey({ provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 })
      )
      await c.open([], { returnedTurns: [turn(2)], paginate: false })
      await c.open([], {
        returnedTurns: [
          {
            ...turn(1),
            status,
            items: [
              { type: 'userMessage', id: 'renumbered-user', text: 'ask 1' },
              { type: 'agentMessage', id: 'renumbered-answer', text: 'Nonprefix saved update' },
              { type: 'agentMessage', id: 'extra', text: 'Extra same-turn answer' }
            ]
          }
        ],
        paginate: false
      })
      const updated = c.journal.item(key)
      expect(updated?.body).toEqual({
        ...old.body,
        contextUsage,
        requestedAt: 500,
        state: status === 'interrupted' ? 'interrupted' : 'completed',
        outcome:
          status === 'completed' ? 'success' : status === 'failed' ? 'failure' : 'cancellation',
        completedAt: (1_700_000_000 + 150) * 1000
      })
      expect(updated?.sequence).toBe(old.sequence)
      expect(c.journal.item(original?.itemId ?? '')).toEqual(original)
      await c.reopen()
      const extra = c.journal
        .snapshot()
        .items.find(
          ({ body }) =>
            body.kind === 'message' &&
            body.blocks.some(
              (block) => block.type === 'text' && block.text === 'Extra same-turn answer'
            )
        )
      expect(extra?.turnScope).toEqual({ kind: 'turn', turnItemId: key })
      const projected = projectStructuredItemsToNativeChat(c.journal.snapshot().items)
      expect(
        nativeChatTurnMembership(projected, c.journal.snapshot()).turnKeys[
          projected.findIndex((item) => item.id === extra?.itemId)
        ]
      ).toBe(original?.itemId)
      const settled = c.journal.item(key)
      await c.open([], {
        returnedTurns: [{ ...turn(1), status: status === 'completed' ? 'failed' : 'completed' }],
        paginate: false
      })
      expect(c.journal.item(key)).toEqual(settled)
    }
  )
}
