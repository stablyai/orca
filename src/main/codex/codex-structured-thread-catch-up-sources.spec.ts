import {
  adapterFor,
  fakeCodex,
  acquireReadyCodexForTest
} from './codex-structured-session-adapter-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

import { expect, it, vi } from 'vitest'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'

import { journalPayload } from '../native-chat/agent-session-journal/journal-payload-bounds'

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  chat as catchUpChat,
  codexWith as catchUpCodexWith,
  turn as catchUpTurn
} from './codex-structured-thread-catch-up.test'

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'

export function registerCodexHistorySourcesTests(input: {
  codexWith: typeof catchUpCodexWith
  chat: typeof catchUpChat
  turn: typeof catchUpTurn
  sessionId: string
  threadId: string
}): void {
  const { chat, turn, sessionId: SESSION, threadId: THREAD } = input
  it.each(['completed', 'failed', 'interrupted'] as const)(
    'reconciles an actual paginated opener from partial to non-prefix %s content once',
    async (status) => {
      const c = await chat({ now: 1_000 })
      const transitions = vi.spyOn(c.deferred.sink, 'tryAppendTransition')
      const supplied = {
        ...turn(1),
        status: 'inProgress',
        completedAt: undefined,
        items: [
          { type: 'userMessage', id: 'u-old', content: [{ type: 'text', text: 'ask 1' }] },
          { type: 'agentMessage', id: 'a-old', text: 'tentative draft' },
          {
            type: 'commandExecution',
            id: 'cmd',
            command: 'pwd',
            cwd: '/workspace',
            status: 'inProgress'
          }
        ]
      }
      const acquired = {
        ...turn(1),
        status,
        items: [
          { type: 'userMessage', id: 'u-new', content: [{ type: 'text', text: 'ask 1' }] },
          { type: 'agentMessage', id: 'a-new', text: 'A different final answer' },
          {
            type: 'commandExecution',
            id: 'cmd',
            command: 'pwd',
            cwd: '/workspace',
            status: 'completed',
            aggregatedOutput: '/workspace',
            exitCode: 0
          },
          {
            type: 'mcpToolCall',
            id: 'mcp',
            server: 'files',
            tool: 'read',
            arguments: { path: 'a' },
            status: 'completed',
            result: { content: [{ type: 'text', text: 'contents' }] }
          }
        ]
      }
      const codex = fakeCodex({
        'thread/resume': () => ({
          thread: { id: THREAD, historyMode: 'paginated', turns: [supplied] }
        }),
        'thread/turns/list': (params) => ({
          data: [
            params?.itemsView === 'summary'
              ? { ...acquired, itemsView: 'summary', items: [] }
              : acquired
          ],
          nextCursor: null
        })
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
            spawnToken: 'evolving-history',
            events: c.deferred.sink
          })
          await c.deferred.drained()
        } finally {
          await adapter.closeAll()
        }
      }
      await open()
      expect(c.texts()).toEqual(['user:ask 1', 'assistant:A different final answer'])
      const rows = c.journal.snapshot().items
      expect(new Set(rows.map((row) => row.itemId)).size).toBe(rows.length)
      expect(rows.find((row) => row.body.kind === 'turn')?.body).toMatchObject({
        kind: 'turn',
        state: status === 'interrupted' ? 'interrupted' : 'completed',
        outcome:
          status === 'completed' ? 'success' : status === 'failed' ? 'failure' : 'cancellation',
        startedAt: (1_700_000_000 + 100) * 1000,
        completedAt: (1_700_000_000 + 150) * 1000
      })
      expect(rows.filter((row) => row.body.kind === 'tool-call').map((row) => row.body)).toEqual([
        expect.objectContaining({ state: 'completed', output: journalPayload('/workspace') }),
        expect.objectContaining({ state: 'completed', output: journalPayload('contents') })
      ])
      expect(new Set(rows.map((row) => row.sequence)).size).toBe(1)
      const imports = () =>
        transitions.mock.calls.flatMap(([call]) =>
          call.steps.filter(
            (step) =>
              step.kind === 'settlement' && step.settlementId.startsWith('codex-history-import:')
          )
        )
      expect(imports()).toHaveLength(1)
      const snapshot = c.journal.snapshot()
      await c.reopen()
      expect(c.journal.snapshot()).toEqual(snapshot)
      const repeated = vi.spyOn(c.deferred.sink, 'tryAppendTransition')
      await open()
      expect(c.journal.snapshot()).toEqual(snapshot)
      await c.open([], {
        paginate: false,
        returnedTurns: [
          {
            ...acquired,
            items: [
              { type: 'commandExecution', id: 'cmd' },
              { type: 'mcpToolCall', id: 'mcp' }
            ]
          }
        ]
      })
      expect(c.journal.snapshot()).toEqual(snapshot)
      expect(
        repeated.mock.calls.flatMap(([call]) =>
          call.steps.filter(
            (step) =>
              step.kind === 'settlement' && step.settlementId.startsWith('codex-history-import:')
          )
        )
      ).toEqual([])
    }
  )

  it('uses source-local message slots and semantic spellings while retaining actual final results', async () => {
    const c = await chat({ now: 1_000 })
    const initial = {
      ...turn(1),
      status: 'inProgress',
      completedAt: undefined,
      items: [
        { type: 'userMessage', id: 'item-0', text: 'ask 1' },
        { type: 'agentMessage', id: 'item-1', text: 'partial' },
        {
          type: 'commandExecution',
          id: 'cmd',
          command: 'pwd',
          status: 'inProgress',
          aggregatedOutput: 'partial'
        },
        { type: 'plan', id: 'timed', text: 'original final', completedAtMs: 10 },
        { type: 'fileChange', id: 'declined', status: 'declined', changes: [] },
        {
          type: 'commandExecution',
          id: 'settled',
          command: 'echo first',
          status: 'completed',
          aggregatedOutput: 'first'
        },
        { type: 'reasoning', id: 'reason', text: 'partial reasoning', completedAtMs: 0 },
        {
          type: 'mcpToolCall',
          id: 'mcp-result',
          server: 'files',
          tool: 'read',
          arguments: { path: 'a' },
          status: 'inProgress',
          result: { content: [{ text: 'partial result' }] }
        },
        { type: 'agentMessage', id: 'item-3', text: 'tail' }
      ]
    }
    await c.open(
      [
        {
          ...turn(1),
          items: [
            { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'ask 1' }] },
            {
              type: 'agentMessage',
              id: 'item-2',
              content: [{ type: 'text', text: 'non-prefix final' }]
            },
            {
              type: 'commandExecution',
              id: 'cmd',
              command: 'pwd',
              status: 'completed',
              aggregated_output: 'final output',
              duration_ms: 12
            },
            { type: 'plan', id: 'timed', text: 'wrong rewrite', completedAtMs: 10 },
            { type: 'fileChange', id: 'declined', status: 'inProgress', changes: [] },
            {
              type: 'commandExecution',
              id: 'settled',
              command: 'echo first',
              status: 'completed',
              aggregatedOutput: 'wrong rewrite'
            },
            {
              type: 'reasoning',
              id: 'reason',
              summary: [{ text: 'final reasoning' }],
              completedAtMs: 20
            },
            { type: 'agentMessage', id: 'item-3', text: 'tail' },
            {
              type: 'mcpToolCall',
              id: 'mcp-result',
              status: 'failed',
              error: { message: 'specific failure' }
            },
            { type: 'plan', id: 'good', text: 'independent good' }
          ]
        }
      ],
      { returnedTurns: [initial] }
    )
    expect(c.texts()).toEqual([
      'user:ask 1',
      'assistant:non-prefix final',
      '(plan-document)',
      'reasoning:final reasoning',
      'assistant:tail',
      '(plan-document)'
    ])
    const bodies = c.journal.snapshot().items.map(({ body }) => body)
    expect(bodies).toContainEqual(
      expect.objectContaining({ kind: 'status', text: 'original final' })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({ kind: 'status', text: 'independent good' })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        callId: 'cmd',
        durationMs: 12,
        output: journalPayload('final output')
      })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        callId: 'settled',
        output: journalPayload('first')
      })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({ kind: 'tool-call', callId: 'declined', state: 'failed' })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: 'final reasoning' }]
      })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        callId: 'mcp-result',
        state: 'failed',
        output: journalPayload('specific failure'),
        mcpIdentity: { server: 'files', tool: 'read' },
        input: { path: 'a' }
      })
    )
    const snapshot = c.journal.snapshot()
    await c.reopen()
    expect(c.journal.snapshot()).toEqual(snapshot)
  })

  it('anchors omitted and later parents while rejecting a different invocation', async () => {
    const c = await chat({ now: 1_000 })
    const parent = {
      type: 'commandExecution',
      id: 'parent',
      command: 'pwd',
      status: 'completed',
      aggregatedOutput: 'retained'
    }
    await c.open([], { paginate: false, returnedTurns: [{ ...turn(1), items: [parent] }] })
    await c.open([], { paginate: false, returnedTurns: [turn(2)] })
    const legacy = {
      provider: 'orca' as const,
      clientMessageId: `codex-history-item:${JSON.stringify([1, THREAD, 'turn-1', 'legacy-parent'])}`
    }
    await c.journal.appendItem(
      legacy,
      {
        kind: 'tool-call',
        name: 'shell',
        callId: 'legacy-parent',
        input: { command: 'legacy' },
        state: 'completed'
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const legacySaved = c.journal.item(agentJournalItemKey(legacy))
    await c.reopen()
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: [
            {
              type: 'plan',
              id: 'omitted-child',
              parentCallId: 'parent',
              text: 'omitted parent child'
            },
            {
              type: 'plan',
              id: 'legacy-child',
              parentCallId: 'legacy-parent',
              text: 'legacy parent child'
            }
          ]
        }
      ]
    })
    expect(c.journal.snapshot().items.map(({ body }) => body)).toContainEqual(
      expect.objectContaining({ kind: 'status', text: 'omitted parent child' })
    )
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: [
            { ...parent, aggregatedOutput: 'refused result' },
            { type: 'plan', id: 'child', parentCallId: 'parent', text: 'saved parent child' },
            {
              type: 'plan',
              id: 'early-child',
              parentCallId: 'later-parent',
              text: 'later parent child'
            },
            { type: 'commandExecution', id: 'later-parent', command: 'ls', status: 'completed' }
          ]
        }
      ]
    })
    const bodies = c.journal.snapshot().items.map(({ body }) => body)
    expect(bodies).toContainEqual(
      expect.objectContaining({ kind: 'status', text: 'saved parent child' })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({ kind: 'status', text: 'later parent child' })
    )
    expect(bodies).toContainEqual(
      expect.objectContaining({
        kind: 'tool-call',
        callId: 'parent',
        output: journalPayload('retained')
      })
    )
    const before = c.journal.snapshot()
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: [
            { ...parent, command: 'different invocation' },
            { type: 'plan', id: 'bad-child', parentCallId: 'parent', text: 'must not attach' }
          ]
        }
      ]
    })
    expect(c.journal.snapshot()).toEqual(before)
    await c.reopen()
    expect(c.journal.item(agentJournalItemKey(legacy))).toEqual(legacySaved)
    const snapshot = c.journal.snapshot()
    const turnKey = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, 'turn-1'))
    for (const text of [
      'omitted parent child',
      'saved parent child',
      'later parent child',
      'legacy parent child'
    ]) {
      const child = snapshot.items.find(({ body }) => body.kind === 'status' && body.text === text)
      expect(child?.turnScope).toEqual({ kind: 'turn', turnItemId: turnKey })
    }
  })

  it('keeps cross-turn live aliases and saved image constraints while allowing valid history fallback and generation', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([], { paginate: false, returnedTurns: [turn(1), turn(2)] })
    const scope = (n: number) => ({
      kind: 'turn' as const,
      turnItemId: agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, `turn-${n}`))
    })
    const live = { provider: 'orca' as const, clientMessageId: `codex-item:${THREAD}:shared` }
    await c.journal.appendItem(
      live,
      {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'old' },
        state: 'completed',
        output: journalPayload('old output')
      },
      { fence: 1, turnScope: scope(1) }
    )
    const oldLive = c.journal.item(agentJournalItemKey(live))
    const unscoped = { provider: 'orca' as const, clientMessageId: `codex-item:${THREAD}:unscoped` }
    await c.journal.appendItem(
      unscoped,
      { kind: 'tool-call', name: 'shell', input: { command: 'unscoped old' }, state: 'completed' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const oldUnscoped = c.journal.item(agentJournalItemKey(unscoped))
    const image = (id: string) => ({
      provider: 'orca' as const,
      clientMessageId: `codex-history-item:${JSON.stringify([1, THREAD, 'turn-1', id])}`
    })
    await c.journal.appendItem(
      image('view'),
      {
        kind: 'message',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Viewed image' },
          { type: 'image-ref', path: '/a.png' }
        ]
      },
      { fence: 1, turnScope: scope(1) }
    )
    await c.journal.appendItem(
      image('missing'),
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Image view: preview unavailable' }]
      },
      { fence: 1, turnScope: scope(1) }
    )
    await c.journal.appendItem(
      image('generated'),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Generating image…' }] },
      { fence: 1, turnScope: scope(1) }
    )
    await c.reopen()
    const oldView = c.journal.item(agentJournalItemKey(image('view')))
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: [
            { type: 'imageView', id: 'view', path: '/b.png' },
            { type: 'imageView', id: 'missing', path: '/filled.png' },
            {
              type: 'imageGeneration',
              id: 'generated',
              status: 'completed',
              savedPath: '/generated.png'
            },
            { type: 'plan', id: 'sibling', text: 'good sibling' }
          ]
        },
        {
          ...turn(2),
          items: [
            {
              type: 'commandExecution',
              id: 'shared',
              command: 'new',
              status: 'completed',
              aggregatedOutput: 'new output'
            },
            {
              type: 'commandExecution',
              id: 'unscoped',
              command: 'unscoped new',
              status: 'completed'
            }
          ]
        }
      ]
    })
    expect(c.journal.item(agentJournalItemKey(live))).toEqual(oldLive)
    expect(c.journal.item(agentJournalItemKey(unscoped))).toEqual(oldUnscoped)
    expect(c.journal.snapshot().items.map(({ body }) => body)).toContainEqual(
      expect.objectContaining({ kind: 'tool-call', input: { command: 'unscoped new', cwd: null } })
    )
    expect(c.journal.item(agentJournalItemKey(image('view')))).toEqual(oldView)
    const historyKey = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `codex-history-item:${JSON.stringify([1, THREAD, 'turn-2', 'shared'])}`
    })
    expect(c.journal.item(historyKey)).toMatchObject({
      turnScope: scope(2),
      body: { input: { command: 'new', cwd: null }, output: journalPayload('new output') }
    })
    expect(c.journal.item(agentJournalItemKey(image('missing')))?.body).toMatchObject({
      blocks: [
        { type: 'text', text: 'Viewed image' },
        { type: 'image-ref', path: '/filled.png' }
      ]
    })
    expect(c.journal.item(agentJournalItemKey(image('generated')))?.body).toMatchObject({
      blocks: [
        { type: 'text', text: 'Generated image' },
        { type: 'image-ref', path: '/generated.png' }
      ]
    })
    const snapshot = c.journal.snapshot()
    await c.open([], {
      paginate: false,
      returnedTurns: [
        {
          ...turn(1),
          items: [
            { type: 'imageView', id: 'view' },
            { type: 'imageGeneration', id: 'generated' }
          ]
        }
      ]
    })
    expect(c.journal.snapshot()).toEqual(snapshot)
  })

  it('releases whole-response groups with more than 1024 unchanged saved keys and keeps a small new turn', async () => {
    const c = await chat({ now: 1_000 })
    const old = Array.from({ length: 30 }, (_, n) => ({
      ...turn(n),
      items: Array.from({ length: 40 }, (_, i) => ({
        type: 'agentMessage',
        id: `a-${i}`,
        text: `answer ${n}/${i}`
      }))
    }))
    for (const entry of old) {
      await c.open([], { paginate: false, returnedTurns: [entry] })
    }
    await c.reopen()
    const before = c.journal.snapshot()
    const commits = vi.spyOn(c.deferred.sink, 'tryAppendTransition')
    await c.open([], { paginate: false, returnedTurns: [...old, turn(31)] })
    expect(c.journal.snapshot().items.slice(0, before.items.length)).toEqual(before.items)
    expect(c.texts().slice(-2)).toEqual(['user:ask 31', 'assistant:answer 31'])
    const imports = commits.mock.calls.flatMap(([call]) =>
      call.steps.filter(
        (step) =>
          step.kind === 'settlement' && step.settlementId.startsWith('codex-history-import:')
      )
    )
    expect(imports).toHaveLength(1)
    const snapshot = c.journal.snapshot()
    await c.open([], { paginate: false, returnedTurns: [...old, turn(31)] })
    expect(c.journal.snapshot()).toEqual(snapshot)
    expect(
      commits.mock.calls.flatMap(([call]) =>
        call.steps.filter(
          (step) =>
            step.kind === 'settlement' && step.settlementId.startsWith('codex-history-import:')
        )
      )
    ).toHaveLength(1)
  })
}
