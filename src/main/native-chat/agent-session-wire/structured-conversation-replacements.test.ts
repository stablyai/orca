import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { StructuredConversationCommandController } from './structured-conversation-command-controller'

function replacements(records: AgentSessionRecord[], visible: string[]) {
  const store = {
    listRecords: () => records,
    listVisibleSessionIds: () => visible,
    getRecord: (id: string) => records.find((record) => record.sessionId === id)
  }
  const controller = new StructuredConversationCommandController(
    () => ({ deps: { store } }) as never,
    {} as never
  )
  return controller.replacements()
}

function record(id: string, next?: string): AgentSessionRecord {
  return {
    sessionId: id,
    provider: 'codex',
    location: { workspaceId: 'folder' },
    conversationCommand: next
      ? { command: 'clear', phase: 'committed', replacementSessionId: next }
      : undefined
  } as AgentSessionRecord
}

describe('conversation replacement projection', () => {
  it('visits a long clear chain only once per snapshot', () => {
    const reads = vi.fn()
    const records = Array.from({ length: 200 }, (_, index) => {
      const entry = record(String(index), index < 199 ? String(index + 1) : undefined)
      const command = entry.conversationCommand
      Object.defineProperty(entry, 'conversationCommand', {
        get: () => {
          reads()
          return command
        }
      })
      return entry
    })
    const result = replacements(records, ['199'])
    expect(result).toHaveLength(199)
    expect(result.every((entry) => entry.sessionId === '199')).toBe(true)
    expect(reads.mock.calls.length).toBeLessThanOrEqual(records.length * 2)
  })

  it('keeps revealed history and closed chains out, and ignores cycles', () => {
    const records = [
      record('a', 'b'),
      record('b', 'c'),
      record('c'),
      record('x', 'y'),
      record('y', 'x')
    ]
    expect(replacements(records, ['b', 'c', 'x'])).toEqual([
      { sourceSessionId: 'a', sessionId: 'c', workspaceId: 'folder', agent: 'codex' }
    ])
    expect(replacements(records, [])).toEqual([])
  })
})
