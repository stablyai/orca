import { describe, expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from '../child-work/claude-child-work-decoder'
import { ClaudeBackgroundTaskTracker } from '../background-tasks/claude-background-task-tracker'
import { claudeRelayOpenWork } from './claude-relay-markers'
import { restateKeptClaudeBackgroundTasks } from './claude-kept-background-tasks'

describe('a kept Claude agent across a reattach', () => {
  it('restates a background task started before it, which reads live until it ends', () => {
    const session = {
      childWork: new ClaudeChildWorkDecoder(),
      backgroundTasks: new ClaudeBackgroundTaskTracker(),
      translator: undefined
    }
    restateKeptClaudeBackgroundTasks(session, ['b1'])
    expect([...session.childWork.live.keys()]).toEqual(['b1'])
    expect(session.backgroundTasks.goalBackgroundWork).toBe('live')
    expect(claudeRelayOpenWork({ ...session, providerSessionId: 's' }, false).task).toEqual([
      ['b1']
    ])
    const ended = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b1',
      status: 'completed'
    }
    session.childWork.observe(ended)
    session.backgroundTasks.observe(ended)
    expect(session.childWork.live.size).toBe(0)
    expect(session.backgroundTasks.goalBackgroundWork).toBe('exited')
  })
})
