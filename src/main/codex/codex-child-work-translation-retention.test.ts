import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import {
  CODEX_CHILD_WORK_TEXT_MAX_CHARS,
  codexChildMessageText,
  codexChildToolCall
} from './codex-child-work-translation'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import {
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  journalTruncationMarker
} from '../native-chat/agent-session-journal/journal-payload-bounds'

describe('Codex child message preview ownership', () => {
  it('owns only the preview after journaling a large completed child message, through its ending', () => {
    const executions = new CodexSubagentExecutions()
    const rows: AgentJournalItemBody[] = []
    const evidence: AgentChildWorkEvidence[] = []
    const tracker = new CodexBackgroundTaskTracker('primary', executions, {
      now: () => 1_500,
      deliver: (edges) => evidence.push(...edges)
    })
    const translator = createCodexJournalTranslator({
      primaryThreadId: () => 'primary',
      sessionId: 'orca',
      subagentExecutions: executions,
      now: () => 1_500,
      sink: {
        appendItem: (_identity, body) => rows.push(body),
        appendTombstone: () => undefined,
        publish: () => undefined
      }
    })
    const event = (method: string, threadId: string, params: unknown) => ({
      type: 'notification' as const,
      sessionId: 'orca',
      method,
      threadId,
      params,
      observedAt: 1_500
    })
    const send = (method: string, threadId: string, params: unknown): void => {
      const frame = event(method, threadId, params)
      expect(translator.handle(frame)).toEqual({ accepted: true })
      tracker.observe(frame)
      tracker.publishChildWork()
    }
    try {
      send('item/started', 'primary', {
        threadId: 'primary',
        turnId: 'parent-turn',
        item: {
          type: 'subAgentActivity',
          id: 'spawn',
          kind: 'started',
          agentThreadId: 'child',
          agentPath: '/root/report'
        }
      })
      send('turn/started', 'child', {
        threadId: 'child',
        turn: { id: 'child-turn', status: 'inProgress' }
      })
      evidence.length = 0
      const text = 'a'.repeat(50 * 1024 * 1024)
      const preview = text.slice(0, CODEX_CHILD_WORK_TEXT_MAX_CHARS)
      const completed = event('item/completed', 'child', {
        threadId: 'child',
        turnId: 'child-turn',
        item: { type: 'agentMessage', id: 'message', text }
      })
      expect(translator.handle(completed)).toEqual({ accepted: true })
      const from = vi.spyOn(Buffer, 'from')
      tracker.observe(completed)
      tracker.publishChildWork()
      const calls: readonly (readonly unknown[])[] = from.mock.calls
      const ownedPrefixes = calls.filter(
        ([value, encoding]) => value === preview && encoding === 'utf16le'
      )
      const onlyPrefixCopied = calls.every(
        ([value]) => typeof value !== 'string' || value.length <= preview.length
      )
      from.mockRestore()
      expect(evidence).toEqual([
        {
          type: 'live',
          observedAt: 1_500,
          child: {
            handle: { idKind: 'thread_id', id: 'child', runId: 'child-turn' },
            kind: 'agent',
            residency: 'background',
            state: 'working',
            description: 'report',
            lastMessage: preview,
            stoppable: true,
            operation: null
          }
        }
      ])
      const digest = createHash('sha256').update(text, 'utf8').digest('hex')
      expect(rows).toContainEqual({
        kind: 'message',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text:
              'a'.repeat(DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes) +
              journalTruncationMarker(text.length, digest)
          }
        ]
      })
      evidence.length = 0
      send('turn/completed', 'child', {
        threadId: 'child',
        turn: { id: 'child-turn', status: 'completed' }
      })
      expect(evidence).toEqual([
        {
          type: 'ended',
          observedAt: 1_500,
          handle: { idKind: 'thread_id', id: 'child', runId: 'child-turn' },
          outcome: 'succeeded',
          lastMessage: preview
        }
      ])
      expect(ownedPrefixes).toEqual([[preview, 'utf16le']])
      expect(onlyPrefixCopied).toBe(true)
    } finally {
      vi.restoreAllMocks()
      translator.dispose()
      tracker.clear()
    }
  })

  it('preserves the existing UTF16 prefix and field fallback at and beyond the cap', () => {
    const lead = 'x'.repeat(CODEX_CHILD_WORK_TEXT_MAX_CHARS - 1)
    const endings = ['a', '\ud800', '\udfff', '🙂', '漢', '\u0000', '\n', '\ud800a\udfff']
    for (const ending of endings) {
      for (const length of [0, 12, 13, 2_047, 2_048, 2_049, 4_096, 65_537]) {
        const text = (lead + ending + 'z'.repeat(65_537)).slice(0, length)
        const expected = text ? text.slice(0, CODEX_CHILD_WORK_TEXT_MAX_CHARS) : undefined
        expect(codexChildMessageText({ type: 'agentMessage', id: 'm', text })).toBe(expected)
        expect(
          codexChildMessageText({
            type: 'agentMessage',
            id: 'm',
            text: '',
            content: [null, { text }, '', { text: 'tail' }]
          })
        ).toBe((text ? `${text}\ntail` : 'tail').slice(0, CODEX_CHILD_WORK_TEXT_MAX_CHARS))
        expect(codexChildToolCall({ type: 'webSearch', id: 'q', query: text })).toEqual(
          expected ? { toolName: 'web_search', input: expected } : { toolName: 'web_search' }
        )
        expect(
          codexChildToolCall({ type: 'fileChange', id: 'f', changes: [{ path: text }] })
        ).toEqual(
          expected ? { toolName: 'apply_patch', input: expected } : { toolName: 'apply_patch' }
        )
      }
    }
  })
})
