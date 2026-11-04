import { describe, expect, it } from 'vitest'
import { CodexBackgroundCommandTracker } from './codex-background-command-tracker'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

function notification(
  method: string,
  params: Record<string, unknown>
): Extract<CodexStructuredSessionEvent, { type: 'notification' }> {
  return {
    type: 'notification',
    sessionId: 'session',
    threadId: 'root',
    method,
    params: { threadId: 'root', turnId: 'turn', ...params }
  }
}

function command(method: string, id = 'exec', threadId = 'root') {
  return {
    ...notification(method, {
      item: {
        type: 'commandExecution',
        id,
        command: 'sleep 30',
        source: 'unifiedExecStartup',
        status: method === 'item/completed' ? 'completed' : 'inProgress',
        exitCode: method === 'item/completed' ? 0 : null
      }
    }),
    threadId
  }
}

describe('persistent command ownership', () => {
  it('promotes only the launching turn and recognizes a start delivered after its end', () => {
    const tracker = new CodexBackgroundCommandTracker('root')
    tracker.observe(command('item/started'))
    expect(tracker.tasks()).toEqual([])
    expect(tracker.endTurn('root', 'another-turn')).toEqual([])
    expect(tracker.endTurn('child', 'turn')).toEqual([])
    expect(tracker.tasks()).toEqual([])
    expect(tracker.endTurn('root', 'turn')).toHaveLength(1)
    expect(tracker.tasks()).toHaveLength(1)
    expect(tracker.endTurn('root', 'turn')).toEqual([])
    tracker.observe(command('item/started', 'late'))
    expect(tracker.tasks()).toHaveLength(2)
    tracker.clear()
    tracker.observe(command('item/started', 'new'))
    expect(tracker.tasks()).toEqual([])
  })

  it('counts child shells only after the child stops covering them, without resurrecting exits', () => {
    const tracker = new CodexBackgroundCommandTracker('root')
    tracker.observe(command('item/started', 'child-exec', 'child'))
    tracker.observe(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'poll',
          source: 'unifiedExecInteraction',
          status: 'inProgress'
        }
      })
    )
    expect(tracker.tasks(new Set(['child']))).toEqual([])
    tracker.endTurn('child', 'turn')
    expect(tracker.tasks()).toEqual([
      { id: 'codex-command:thread:child:child-exec', kind: 'command', description: 'sleep 30' }
    ])
    tracker.observe(command('item/completed', 'child-exec', 'child'))
    tracker.observe(command('item/started'))
    tracker.observe(command('item/completed'))
    tracker.observe(command('item/started'))
    expect(tracker.tasks()).toEqual([])
  })

  it('retains live commands while recycling bounded settled history', () => {
    const tracker = new CodexBackgroundCommandTracker('root')
    tracker.observe(command('item/started', 'long-lived'))
    for (let index = 0; index < 300; index += 1) {
      tracker.observe(command('item/started', `short-${index}`))
      tracker.observe(command('item/completed', `short-${index}`))
    }
    tracker.endTurn('root', 'turn')
    expect(tracker.tasks()).toEqual([
      { id: 'codex-command:primary:long-lived', kind: 'command', description: 'sleep 30' }
    ])
    tracker.clear()
    expect(tracker.tasks()).toEqual([])
  })
})
