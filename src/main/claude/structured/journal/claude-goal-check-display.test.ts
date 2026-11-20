import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionThreadGoalReport } from '../../../../shared/agent-session/thread-goals/agent-session-thread-goal-report'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { omitNativeChatThreadGoalRows } from '../../../../shared/native-chat/transcript/turns/native-chat-thread-goal-rows'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import {
  nativeChatTurnFold,
  nativeChatTurnFoldRow
} from '../../../../shared/native-chat/transcript/folding/native-chat-turn-fold'

it.each(['Finish the task', 'a'.repeat(510)])(
  'groups checks for %s without changing provider completion or other hooks',
  (objective) => {
    const items: AgentJournalRenderItem[] = []
    const translator = createClaudeJournalTranslator({
      goalBackgroundWork: () => 'exited',
      sink: {
        appendItem: (identity, body) => {
          const itemId = JSON.stringify(identity)
          const existing = items.find((item) => item.itemId === itemId)
          if (existing) {
            existing.body = body
          } else {
            items.push({
              itemId,
              sequence: items.length + 1,
              revision: 1,
              observedAt: 1_000,
              body
            })
          }
        },
        appendTombstone: () => {},
        publish: () => {}
      }
    })
    let frame = 0
    const send = (message: Record<string, unknown>) =>
      translator.handle({
        type: 'message',
        sessionId: 'orca',
        observedAt: 1_000,
        message: {
          session_id: 'claude',
          uuid: `frame-${++frame}`,
          parent_tool_use_id: null,
          ...message
        }
      })
    const answer = (text: string, model = '<synthetic>') =>
      send({
        type: 'assistant',
        message: { role: 'assistant', model, content: [{ type: 'text', text }] }
      })
    const feedback = (label: string, reason: string) =>
      send({
        type: 'user',
        isSynthetic: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Stop hook feedback:\n[${label}]: ${reason}` }]
        }
      })
    try {
      answer(`Goal set: ${objective}`)
      answer('Working.', 'claude-sonnet')
      const label = objective.length > 500 ? `${'a'.repeat(500)}… [+10 chars]` : objective
      feedback(label, 'First check')
      feedback('user-stop-command', 'Keep this warning')
      feedback(label, 'Goal check\n[lint-command]: Keep this mixed warning')
      feedback(label, 'Latest check')
      const report = agentSessionThreadGoalReport({
        journalItems: items,
        support: undefined,
        reported: { current: null }
      })
      expect(report?.goal).toMatchObject({ status: 'active', checks: 2, lastCheck: 'Latest check' })
      expect(
        items
          .filter(
            (item) => item.body.kind === 'status' && item.body.presentation === 'hook-sent-back'
          )
          .map((item) => item.body)
      ).toMatchObject([
        { text: 'Stop hook feedback: Keep this warning' },
        { text: expect.stringContaining('Keep this mixed warning') }
      ])
      expect(
        items
          .filter((item) => item.body.kind === 'status' && item.body.threadGoal)
          .some(
            (item) =>
              'checks' in
              (item.body.kind === 'status' && item.body.threadGoal?.state === 'set'
                ? item.body.threadGoal.goal
                : {})
          )
      ).toBe(false)
      send({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 })
      expect(
        agentSessionThreadGoalReport({
          journalItems: items,
          support: undefined,
          reported: { current: null }
        })?.goal?.status
      ).toBe('complete')
      const messages: NativeChatMessage[] = items.flatMap((item) =>
        item.body.kind === 'status'
          ? [
              {
                id: item.itemId,
                role: 'system',
                source: 'transcript',
                timestamp: 1_000,
                blocks: [
                  {
                    type: 'text',
                    text: item.body.text,
                    presentation: item.body.threadGoal ? 'thread-goal' : item.body.presentation
                  }
                ]
              }
            ]
          : []
      )
      expect(
        omitNativeChatThreadGoalRows(messages)
          .filter((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.presentation === 'goal-check-summary'
            )
          )
          .map((message) => message.blocks[0])
      ).toMatchObject([{ text: '2\nLatest check' }])
    } finally {
      translator.dispose()
    }
  }
)

it.each(['complete', 'replaced', 'clear'])(
  'keeps rejected answers and the latest goal check visible after %s',
  (ending) => {
    const row = (
      id: string,
      role: NativeChatMessage['role'],
      text: string,
      presentation?: string
    ): NativeChatMessage => ({
      id,
      role,
      source: 'transcript',
      timestamp: 1_000,
      blocks: [{ type: 'text', text, presentation }]
    })
    const boundary =
      ending === 'clear'
        ? {
            ...row('end', 'system', 'Context cleared', 'context-cleared'),
            blocks: [
              {
                type: 'text' as const,
                text: 'Context cleared',
                presentation: 'context-cleared',
                contextClear: { operationId: 'clear', afterFence: 0, clearedAt: 1_000 }
              }
            ]
          }
        : row(
            'end',
            'system',
            ending === 'complete' ? 'Goal complete: Task' : 'Goal set: Next',
            'thread-goal'
          )
    const messages = omitNativeChatThreadGoalRows([
      row('goal', 'system', 'Goal set: Task', 'thread-goal'),
      row('first', 'assistant', 'First answer'),
      row('check1', 'system', 'Stop hook feedback: First check', 'goal-check'),
      row('work', 'system', 'Running checks'),
      row('second', 'assistant', 'Revised answer'),
      row('check2', 'system', 'Stop hook feedback: Latest check', 'goal-check'),
      boundary
    ])
    const fold = nativeChatTurnFold({
      rows: messages.map((message) => nativeChatTurnFoldRow(message, 'turn', undefined)),
      settledTurnKeys: new Set(['turn']),
      expandedTurnKeys: new Set()
    })
    const visible = messages
      .filter((_message, index) => !fold.foldedRows.has(index))
      .map((message) => message.id)
    expect(visible).toContain('first')
    expect(visible).toContain('second')
    expect(visible).toContain('check2')
    expect(messages.find((message) => message.id === 'check2')?.blocks[0]).toMatchObject({
      text: '2\nLatest check'
    })
  }
)
