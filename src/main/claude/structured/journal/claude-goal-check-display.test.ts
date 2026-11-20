import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionThreadGoalReport } from '../../../../shared/agent-session/thread-goals/agent-session-thread-goal-report'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

it.each(['Finish the task', 'a'.repeat(510)])(
  'groups checks for %s without changing provider completion or other hooks',
  (objective) => {
    const items: AgentJournalRenderItem[] = []
    const translator = createClaudeJournalTranslator({
      goalBackgroundWork: () => 'exited',
      sink: {
        appendItem: (identity, body) => {
          const existing = items.find((item) => item.itemId === identity.uuid)
          if (existing) {
            existing.body = body
          } else {
            items.push({
              itemId: identity.uuid,
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
      ).toMatchObject([{ text: 'Stop hook feedback: Keep this warning' }])
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
    } finally {
      translator.dispose()
    }
  }
)
