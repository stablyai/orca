import { describe, expect, it } from 'vitest'
import { journalItemCliLines } from './chat-transcript-lines'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'

function item(overrides: Partial<AgentJournalRenderItem>): AgentJournalRenderItem {
  return {
    itemId: 'i1',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'status', text: 'x' },
    ...overrides
  }
}

describe('journalItemCliLines', () => {
  it('renders a user message with its role', () => {
    expect(
      journalItemCliLines(
        item({
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'fix the picker' }]
          }
        })
      )
    ).toEqual(['user: fix the picker'])
  })

  it('prefixes subagent-owned rows with the producing agent id', () => {
    expect(
      journalItemCliLines(
        item({
          agentId: 'p:copper',
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] }
        })
      )
    ).toEqual(['[p:copper] assistant: done'])
  })

  it('marks a shortened tool output as truncated', () => {
    expect(
      journalItemCliLines(
        item({
          body: {
            kind: 'tool-call',
            name: 'Bash',
            input: { command: 'ls' },
            state: 'completed',
            output: { head: 'a.ts\nb.ts', byteLength: 100, digest: 'd', truncated: true }
          }
        })
      )
    ).toEqual(['tool Bash (completed): {"command":"ls"}\na.ts\nb.ts [truncated]'])
  })

  it('drops messages whose blocks carry no renderable text', () => {
    expect(
      journalItemCliLines(
        item({
          body: { kind: 'message', role: 'assistant', blocks: [] }
        })
      )
    ).toEqual([])
  })
})
