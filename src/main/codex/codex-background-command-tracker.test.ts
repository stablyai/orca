import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { CodexBackgroundCommandTracker } from './codex-background-command-tracker'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'

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
  it('preflights finite metadata capacity and admits work again after process completion', () => {
    const tracker = new CodexBackgroundCommandTracker('root', 700)
    const first = command('item/started', 'first')
    const second = command('item/started', 'second')
    expect(tracker.canObserve(first)).toBe(true)
    tracker.observe(first)
    expect(tracker.canObserve(second)).toBe(false)
    expect(() => tracker.observe(second)).toThrow('not admitted')
    expect(tracker.tasks()).toHaveLength(1)
    expect(tracker.retainedMetadataBytes).toBeLessThanOrEqual(700)
    tracker.observe(command('item/completed', 'first'))
    expect(tracker.canObserve(second)).toBe(true)
    tracker.observe(second)
    expect(tracker.tasks()).toHaveLength(1)
    expect(tracker.retainedMetadataBytes).toBeLessThanOrEqual(700)
    tracker.clear()
    expect(tracker.retainedMetadataBytes).toBe(0)
  })

  it('keeps the journal running across turn completion and accepts late output and exit', () => {
    const rows: { key: string; body: AgentJournalItemBody }[] = []
    const translator = createCodexJournalTranslator({
      primaryThreadId: () => 'root',
      sink: {
        appendItem: (identity, body) => rows.push({ key: agentJournalItemKey(identity), body }),
        appendTombstone: () => {},
        publish: () => {}
      }
    })
    const tracker = new CodexBackgroundCommandTracker('root')
    const deliver = (event: Extract<CodexStructuredSessionEvent, { type: 'notification' }>) => {
      expect(translator.handle(event)).toEqual({ accepted: true })
      tracker.observe(event)
    }
    deliver(notification('turn/started', { turn: { id: 'turn' } }))
    deliver(command('item/started'))
    const originalKey = rows.find(({ body }) => body.kind === 'tool-call')?.key
    deliver(notification('turn/completed', { turn: { id: 'turn' } }))
    expect(rows.filter(({ body }) => body.kind === 'tool-call').map(({ body }) => body)).toEqual([
      expect.objectContaining({ state: 'running' })
    ])
    expect(tracker.tasks()).toHaveLength(1)
    deliver(
      notification('item/commandExecution/outputDelta', { itemId: 'exec', delta: 'late output' })
    )
    translator.flush()
    expect(rows.at(-1)).toMatchObject({ key: originalKey, body: { state: 'running' } })
    deliver(command('item/completed'))
    expect(rows.at(-1)).toMatchObject({ key: originalKey, body: { state: 'completed' } })
    expect(tracker.tasks()).toEqual([])
    translator.dispose()
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
    expect(tracker.tasks()).toEqual([
      { id: 'codex-command:primary:long-lived', kind: 'command', description: 'sleep 30' }
    ])
    tracker.clear()
    expect(tracker.tasks()).toEqual([])
  })
})
