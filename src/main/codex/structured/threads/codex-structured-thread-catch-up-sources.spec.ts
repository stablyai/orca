import {
  adapterFor,
  fakeCodex,
  acquireReadyCodexForTest
} from '../session-lifecycle/codex-structured-session-adapter-fixture'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { expect, it, vi } from 'vitest'
import { codexTurnLifecycleIdentity } from '../journal/codex-structured-journal-translation-turns'
import { journalPayload } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  chat as catchUpChat,
  codexWith as catchUpCodexWith,
  turn as catchUpTurn
} from './codex-thread-catch-up-contract-test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'

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

  it('conserves saved invocation facts after disk reopen without adopting incompatible dependents', async () => {
    const c = await chat({ now: 1_000 })
    const open = async (turns: Record<string, unknown>[]) => {
      const adapter = adapterFor(
        fakeCodex({
          'thread/resume': () => ({ thread: { id: THREAD, turns } })
        }),
        { resumeThreadId: THREAD }
      )
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
          spawnToken: 'saved-invocation-facts',
          events: c.deferred.sink
        })
        await c.deferred.drained()
      } finally {
        await adapter.closeAll()
      }
    }
    const mcp = {
      type: 'mcpToolCall',
      server: 's',
      tool: 'lookup',
      arguments: {},
      status: 'completed'
    }
    const command = { type: 'commandExecution', command: 'pwd', cwd: '/work', status: 'completed' }
    const collisions = [
      { id: 'mcp-command', saved: mcp, incoming: command },
      {
        id: 'mcp-file',
        saved: mcp,
        incoming: { type: 'fileChange', changes: [{ path: 'a', diff: '+a' }] }
      },
      {
        id: 'mcp-web',
        saved: mcp,
        incoming: {
          type: 'webSearch',
          query: 'lookup',
          action: { type: 'search', query: 'lookup' }
        }
      },
      {
        id: 'mcp-collab',
        saved: mcp,
        incoming: {
          type: 'collabAgentToolCall',
          tool: 'sendInput',
          prompt: 'lookup',
          status: 'completed'
        }
      },
      { id: 'command-mcp', saved: command, incoming: mcp },
      {
        id: 'command-web',
        saved: command,
        incoming: { type: 'webSearch', query: 'pwd', action: { type: 'search', query: 'pwd' } }
      },
      {
        id: 'collab-command',
        saved: {
          type: 'collabAgentToolCall',
          tool: 'sendInput',
          prompt: 'retained input',
          status: 'completed'
        },
        incoming: command
      }
    ]
    const placeholder = { type: 'fileChange', id: 'patch', status: 'inProgress' }
    const source = {
      ...turn(1),
      items: [
        ...collisions.map(({ id, saved }) => ({ ...saved, id })),
        { ...command, id: 'sparse-command' },
        placeholder
      ]
    }
    await open([source])
    const saved = collisions.map(({ id }) =>
      c.journal.snapshot().items.find(({ body }) => body.kind === 'tool-call' && body.callId === id)
    )
    expect(saved).toHaveLength(collisions.length)
    for (const row of saved) {
      expect(row?.body.kind).toBe('tool-call')
    }
    expect(saved[0]?.body).toMatchObject({
      mcpIdentity: { server: 's', tool: 'lookup' },
      input: null
    })
    const sparse = c.journal
      .snapshot()
      .items.find(({ body }) => body.kind === 'tool-call' && body.callId === 'sparse-command')
    expect(sparse?.body).toMatchObject({
      kind: 'tool-call',
      input: { command: 'pwd', cwd: '/work' }
    })
    const originalPatch = c.journal
      .snapshot()
      .items.find(({ body }) => body.kind === 'tool-call' && body.callId === 'patch')
    expect(originalPatch?.revision).toBe(1)
    await c.reopen()
    const transitions = vi.spyOn(c.deferred.sink, 'tryAppendTransition')
    const incoming = {
      ...source,
      items: [
        ...collisions.flatMap(({ id, incoming }) => [
          { ...incoming, id },
          { type: 'plan', id: `bad-child-${id}`, parentCallId: id, text: `must not attach ${id}` }
        ]),
        { type: 'commandExecution', id: 'sparse-command' },
        { ...placeholder, status: 'completed', changes: [{ path: 'a', diff: '+a' }] },
        { type: 'plan', id: 'good', text: 'independent good display' }
      ]
    }
    await open([incoming, turn(2)])
    for (const row of saved) {
      expect(row && c.journal.item(row.itemId)).toEqual(row)
    }
    expect(sparse && c.journal.item(sparse.itemId)).toEqual(sparse)
    const snapshot = c.journal.snapshot()
    expect(snapshot.items.filter(({ body }) => body.kind === 'tool-call')).toEqual([
      ...saved,
      sparse
    ])
    expect(
      snapshot.items.some(
        ({ body }) => body.kind === 'status' && body.text.startsWith('must not attach')
      )
    ).toBe(false)
    const good = snapshot.items.find(
      ({ body }) => body.kind === 'status' && body.text === 'independent good display'
    )
    expect(good?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, 'turn-1'))
    })
    expect(snapshot.items.map(({ body }) => body)).toContainEqual({
      kind: 'diff',
      path: 'a',
      patch: journalPayload('+a')
    })
    expect(c.texts()).toEqual([
      '(continued-outside)',
      '(plan-document)',
      'user:ask 2',
      'assistant:answer 2'
    ])
    expect(
      transitions.mock.calls.flatMap(([call]) =>
        call.steps.filter(
          (step) =>
            step.kind === 'settlement' && step.settlementId.startsWith('codex-history-import:')
        )
      )
    ).toHaveLength(1)
    const display = snapshot.items.filter(
      ({ body }) =>
        body.kind === 'diff' || (body.kind === 'status' && body.presentation === 'plan-document')
    )
    expect(display).toHaveLength(2)
    expect(display.find(({ body }) => body.kind === 'diff')).toMatchObject({
      itemId: originalPatch?.itemId,
      sequence: originalPatch?.sequence,
      sequenceIndex: originalPatch?.sequenceIndex,
      turnScope: originalPatch?.turnScope,
      revision: 2
    })
    await c.reopen()
    expect(c.journal.snapshot()).toEqual(snapshot)
    await open([incoming, turn(2)])
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
