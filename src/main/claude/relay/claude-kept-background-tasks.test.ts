import { describe, expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from '../child-work/claude-child-work-decoder'
import { ClaudeBackgroundTaskTracker } from '../background-tasks/claude-background-task-tracker'
import { claudeRelayOpenWork } from './claude-relay-markers'
import { restateKeptClaudeBackgroundTasks } from './claude-kept-background-tasks'
import { ClaudeTaskInvocations } from '../background-tasks/claude-task-invocations'

describe('a kept Claude agent across a reattach', () => {
  it('restates a background task started before it, which reads live until it ends', () => {
    // The journal saved b1 as a background task; f1 is a foreground command.
    const saved = new ClaudeTaskInvocations({
      background: (id) =>
        id === 'b1'
          ? {
              identity: { provider: 'orca', clientMessageId: 'task:b1' },
              generation: 1,
              linkage: {}
            }
          : undefined,
      parent: () => undefined,
      isSubagent: (id) => id === 'a1'
    })
    const session = {
      childWork: new ClaudeChildWorkDecoder(saved),
      backgroundTasks: new ClaudeBackgroundTaskTracker()
    }
    restateKeptClaudeBackgroundTasks(session, ['b1', 'f1', 'a1'])
    expect([...session.childWork.live.keys()]).toEqual(['b1', 'f1', 'a1'])
    expect(session.childWork.live.get('f1')?.backgrounded).toBe(false)
    // A subagent the journal knows, still running after its turn, is a background one.
    expect(session.childWork.live.get('a1')?.backgrounded).toBe(true)
    expect(session.backgroundTasks.goalBackgroundWork).toBe('live')
    expect(claudeRelayOpenWork({ ...session, providerSessionId: 's' }, false).task).toEqual([
      ['b1'],
      ['f1'],
      ['a1']
    ])
    const ended = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b1',
      status: 'completed'
    }
    session.childWork.observe(ended)
    session.backgroundTasks.observe(ended)
    expect([...session.childWork.live.keys()]).toEqual(['f1', 'a1'])
    expect(session.backgroundTasks.goalBackgroundWork).toBe('live')
  })
})
