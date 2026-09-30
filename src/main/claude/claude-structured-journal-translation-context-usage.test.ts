import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { isAdmissibleAgentJournalItemBody } from '../../shared/agent-session-journal-schemas'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import { claudeContextReportFromControl } from './claude-context-usage'
import {
  assistantFrame,
  compactBoundary,
  frame,
  initFrame,
  journal,
  resultFrame,
  setup,
  turnIdentity,
  userFrame
} from './claude-context-usage-test-support'
import { ClaudeOpenTurn } from './claude-open-turn'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { childExited, sessionFor, userMessage } from './claude-structured-dispatch-test-support'

const MODEL_USAGE = {
  'claude-haiku-4-5': { contextWindow: 200_000 },
  'claude-fable-5-1[1m]': { contextWindow: 1_000_000 }
}

describe('context usage on journal rows', () => {
  it('records main-thread usage, and the result window on the settled turn in one revision', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 18_600))
    expect(t.turnRow('turn-a')?.body).toMatchObject({
      state: 'running',
      contextUsage: {
        used: {
          kind: 'estimate',
          usage: { inputTokens: 18_600, outputTokens: 4 },
          capturedAt: 2_000
        }
      }
    })
    const before = t.appends.length
    t.handle(resultFrame(3_000, MODEL_USAGE))
    const turnRevisions = t.appends
      .slice(before)
      .filter((entry) => agentJournalItemKey(entry.identity) === t.turnRow('turn-a')?.itemId)
    expect(turnRevisions).toHaveLength(1)
    expect(turnRevisions[0]?.body).toMatchObject({
      state: 'completed',
      contextUsage: {
        window: { tokens: 1_000_000, capturedAt: 3_000 },
        used: { kind: 'estimate' }
      }
    })
    expect(t.requests).toEqual([turnIdentity('turn-a')])
    expect(selectStructuredAgentContextUsage(t.items())).toMatchObject({
      usedTokens: 18_600,
      windowTokens: 1_000_000,
      estimated: true
    })
    t.translator.dispose()
  })

  it('revises a turn it can name by key, and scans only when no turn is open', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 18_600))
    t.handle(assistantFrame('reply-a2', 2_500, 19_600))
    t.handle(resultFrame(3_000, MODEL_USAGE))
    t.translator.recordContextReport(
      turnIdentity('turn-a'),
      claudeContextReportFromControl(
        { model: 'claude-fable-5-1[1m]', totalTokens: 20_000, rawMaxTokens: 1_000_000 },
        3_500
      )!,
      'report'
    )
    expect(t.scans.count).toBe(0)
    t.handle(compactBoundary(4_000))
    expect(t.scans.count).toBe(1)
    expect(t.turnRow('turn-a')?.body).toMatchObject({ contextUsage: { used: { kind: 'unknown' } } })
    t.translator.dispose()
  })

  it('reads the window of the model the main thread ran on, not the largest one used', () => {
    const t = setup()
    const entry = (contextWindow: number, inputTokens: number) => ({ contextWindow, inputTokens })
    const windowOf = (turnId: string) => {
      const body = t.turnRow(turnId)?.body
      return body?.kind === 'turn' ? body.contextUsage?.window?.tokens : undefined
    }
    t.handle(initFrame('claude-fable-5-1[1m]', 900))
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 18_600))
    t.handle(resultFrame(3_000, { 'claude-fable-5-1[1m]': entry(1_000_000, 18_600) }))
    expect(windowOf('turn-a')).toBe(1_000_000)
    // The user moved to a 200k model; the 1M entry stays in the cumulative usage.
    t.handle(initFrame('claude-sonnet-5', 3_900))
    t.handle(userFrame('turn-b', 4_000))
    t.handle(assistantFrame('reply-b', 5_000, 20_000, undefined, 'claude-sonnet-5'))
    t.handle(
      resultFrame(6_000, {
        'claude-fable-5-1[1m]': entry(1_000_000, 18_600),
        'claude-sonnet-5': entry(200_000, 20_000)
      })
    )
    expect(windowOf('turn-b')).toBe(200_000)
    // Same model without `[1m]`: only the turn's init tells the two entries apart.
    t.handle(initFrame('claude-fable-5-1', 6_900))
    t.handle(userFrame('turn-c', 7_000))
    t.handle(assistantFrame('reply-c', 8_000, 21_000))
    t.handle(
      resultFrame(9_000, {
        'claude-fable-5-1[1m]': entry(1_000_000, 18_600),
        'claude-sonnet-5': entry(200_000, 20_000),
        'claude-fable-5-1': entry(200_000, 21_000)
      })
    )
    expect(windowOf('turn-c')).toBe(200_000)
    // A subagent on a larger-window model leaves the main thread's window alone.
    t.handle(initFrame('claude-sonnet-5', 9_900))
    t.handle(userFrame('turn-d', 10_000))
    t.handle(assistantFrame('reply-d', 11_000, 22_000, undefined, 'claude-sonnet-5'))
    t.handle(assistantFrame('child-d', 11_500, 9_000, 'toolu_task', 'claude-fable-5-1'))
    t.handle(
      resultFrame(12_000, {
        'claude-fable-5-1[1m]': entry(1_000_000, 27_600),
        'claude-sonnet-5': entry(200_000, 42_000),
        'claude-fable-5-1': entry(200_000, 21_000)
      })
    )
    expect(windowOf('turn-d')).toBe(200_000)
    expect(selectStructuredAgentContextUsage(t.items())).toMatchObject({
      usedTokens: 22_000,
      windowTokens: 200_000
    })
    t.translator.dispose()
  })

  it('names the main model from its responses when no init frame does', () => {
    const t = setup({ init: null })
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 20_000, undefined, 'claude-sonnet-5'))
    t.handle(
      resultFrame(3_000, {
        'claude-fable-5-1[1m]': { contextWindow: 1_000_000 },
        'claude-sonnet-5': { contextWindow: 200_000 }
      })
    )
    expect(t.turnRow('turn-a')?.body).toMatchObject({
      contextUsage: { window: { tokens: 200_000 } }
    })
    t.translator.dispose()
  })

  it('keeps usage off a subagent response, which measures the subagent window', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('child-reply', 2_000, 9_000, 'toolu_task'))
    expect(t.appends.some((entry) => entry.body.kind === 'message')).toBe(true)
    expect(t.turnRow('turn-a')?.body).not.toHaveProperty('contextUsage')
    t.translator.dispose()
  })

  it('moves the meter on a tool-only response, once per response', () => {
    const t = setup()
    const toolOnly = (uuid: string, at: number, input: number, toolId: string) =>
      assistantFrame(uuid, at, input, undefined, 'claude-fable-5-1', [
        { type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/a' } }
      ])
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 18_600))
    t.handle(resultFrame(3_000, MODEL_USAGE))
    t.handle(userFrame('turn-b', 4_000))
    const replies = () =>
      t.appends.filter((entry) => entry.body.kind === 'message' && entry.body.role === 'assistant')
    const repliesBefore = replies().length
    t.handle(toolOnly('call-b1', 5_000, 60_000, 'toolu_1'))
    // No message row: the usage has to live somewhere a text-less response writes.
    expect(replies()).toHaveLength(repliesBefore)
    expect(selectStructuredAgentContextUsage(t.items())).toMatchObject({
      usedTokens: 60_000,
      windowTokens: 1_000_000
    })
    // The CLI sends one frame per block of a response; the row is revised once.
    const revisions = t.turnRow('turn-b')?.revision
    t.handle(toolOnly('call-b1', 5_100, 60_000, 'toolu_2'))
    expect(t.turnRow('turn-b')?.revision).toBe(revisions)
    // An auto-compaction mid-turn hides the size until the next response restates it.
    t.handle(compactBoundary(6_000))
    expect(selectStructuredAgentContextUsage(t.items())).toBeNull()
    t.handle(toolOnly('call-b2', 7_000, 30_000, 'toolu_3'))
    expect(selectStructuredAgentContextUsage(t.items())).toMatchObject({
      usedTokens: 30_000,
      estimated: true
    })
    t.translator.dispose()
  })

  it('marks the context unknown at a compaction and asks for a fresh breakdown', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 150_000))
    t.handle(resultFrame(3_000, MODEL_USAGE))
    expect(selectStructuredAgentContextUsage(t.items())).toMatchObject({ usedTokens: 150_000 })
    t.handle(compactBoundary(4_000))
    expect(t.turnRow('turn-a')?.body).toMatchObject({
      contextUsage: { window: { tokens: 1_000_000 }, used: { kind: 'unknown', capturedAt: 4_000 } }
    })
    // No turn is open, so the report lands on the newest turn when it arrives.
    expect(t.requests).toEqual([turnIdentity('turn-a'), null])
    expect(selectStructuredAgentContextUsage(t.items())).toBeNull()
    // Mid-turn compaction lands on the open turn, and its next response restates the size.
    t.handle(userFrame('turn-b', 5_000))
    t.handle(compactBoundary(6_000))
    expect(t.turnRow('turn-b')?.body).toMatchObject({
      state: 'running',
      contextUsage: { used: { kind: 'unknown', capturedAt: 6_000 } }
    })
    t.handle(assistantFrame('reply-b', 7_000, 12_000))
    expect(selectStructuredAgentContextUsage(t.items())).toMatchObject({
      usedTokens: 12_000,
      windowTokens: 1_000_000
    })
    t.translator.dispose()
  })

  it('marks the context unknown at a conversation reset without asking for a report', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 150_000))
    t.handle(resultFrame(3_000, MODEL_USAGE))
    t.handle(frame({ type: 'conversation_reset', new_conversation_id: 'next', uuid: 'r' }, 4_000))
    expect(t.turnRow('turn-a')?.body).toMatchObject({
      contextUsage: { used: { kind: 'unknown', capturedAt: 4_000 } }
    })
    expect(t.requests).toEqual([turnIdentity('turn-a')])
    expect(selectStructuredAgentContextUsage(t.items())).toBeNull()
    t.translator.dispose()
  })

  it('moves the activity count with the main conversation and sends, not a subagent', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    const afterUser = t.translator.contextActivity
    expect(afterUser).toBeGreaterThan(0)
    t.handle(assistantFrame('child-reply', 2_000, 9_000, 'toolu_task'))
    t.handle(frame({ type: 'system', subtype: 'task_progress', uuid: 's' }, 2_100))
    expect(t.translator.contextActivity).toBe(afterUser)
    t.handle(
      frame(
        {
          type: 'stream_event',
          uuid: 'se',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }
        },
        2_200
      )
    )
    expect(t.translator.contextActivity).toBe(afterUser + 1)
    t.translator.markContextActivity()
    expect(t.translator.contextActivity).toBe(afterUser + 2)
    t.translator.dispose()
  })

  it('moves the activity count when a send is accepted, before the CLI echoes it', async () => {
    const t = setup()
    const session = sessionFor()
    session.translator = t.translator
    const outcome = dispatchClaudeTurn(session, {
      body: userMessage([{ type: 'text', text: 'next' }])
    })
    await vi.waitFor(() => expect(t.translator.contextActivity).toBe(1))
    childExited(session)
    await outcome
    t.translator.dispose()
  })

  it('writes rows the journal replay admits, and a restart reads the same ring from them', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 18_600))
    t.handle(resultFrame(3_000, MODEL_USAGE))
    const report = claudeContextReportFromControl(
      {
        model: 'claude-fable-5-1[1m]',
        totalTokens: 1_100_000,
        rawMaxTokens: 1_000_000,
        percentage: 110,
        isAutoCompactEnabled: true,
        autoCompactThreshold: 0,
        categories: [
          { name: 'Messages', tokens: 1_100_000, color: 'x' },
          { name: 'MCP tools (deferred)', tokens: 0, color: 'x', isDeferred: true }
        ]
      },
      3_500
    )
    expect(report).not.toBeNull()
    t.translator.recordContextReport(turnIdentity('turn-a'), report!, 'report')
    const before = t.appends.length
    t.translator.recordContextReport(turnIdentity('never-a-turn'), report!, 'report')
    expect(t.appends).toHaveLength(before)
    t.handle(compactBoundary(4_000))
    for (const entry of t.appends) {
      expect(isAdmissibleAgentJournalItemBody(entry.body)).toBe(true)
    }
    const replayed: AgentJournalRenderItem[] = JSON.parse(JSON.stringify(t.items()))
    expect(selectStructuredAgentContextUsage(replayed)).toBeNull()
    const reportAfterCompaction = { ...report!, usedTokens: 40_000, capturedAt: 4_500 }
    t.translator.recordContextReport(null, reportAfterCompaction, 'report')
    const restarted: AgentJournalRenderItem[] = JSON.parse(JSON.stringify(t.items()))
    expect(restarted.every((row) => isAdmissibleAgentJournalItemBody(row.body))).toBe(true)
    expect(selectStructuredAgentContextUsage(restarted)).toMatchObject({
      usedTokens: 40_000,
      windowTokens: 1_000_000,
      estimated: false
    })
    t.translator.dispose()
  })

  it('keeps the size a turn reached when the child ends it without a result', () => {
    const t = setup()
    t.handle(userFrame('turn-a', 1_000))
    t.handle(assistantFrame('reply-a', 2_000, 18_600))
    t.handle(resultFrame(3_000, MODEL_USAGE))
    t.handle(userFrame('turn-b', 4_000))
    t.handle(assistantFrame('reply-b', 5_000, 42_000))
    t.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed', observedAt: 6_000 })
    expect(t.turnRow('turn-b')?.body).toMatchObject({
      state: 'interrupted',
      contextUsage: { used: { kind: 'estimate', usage: { inputTokens: 42_000 } } }
    })
    expect(selectStructuredAgentContextUsage(t.items())).toMatchObject({ usedTokens: 42_000 })
    t.translator.dispose()
  })

  it('counts a turn opening as activity, whatever frame opened it', () => {
    const onOpen = vi.fn()
    const turn = new ClaudeOpenTurn({ sink: journal().sink, settleChildren: () => {}, onOpen })
    turn.open(
      { sessionId: 'claude-session', turnId: 'turn-a', startedAt: 1_000, userItemId: 'turn-a' },
      1_000
    )
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
