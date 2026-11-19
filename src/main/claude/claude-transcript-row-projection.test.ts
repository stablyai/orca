import { expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { createClaudeTranscriptRowProjection } from './claude-transcript-row-projection'

const scope = { kind: 'turn', turnItemId: 'turn' } as const

function project(saved: AgentJournalItemBody, incoming: AgentJournalItemBody) {
  const mutations = new Map()
  const savedItem: AgentJournalRenderItem = {
    itemId: 'tool',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: saved
  }
  createClaudeTranscriptRowProjection({
    mutations,
    saved: () => savedItem,
    scopeOf: () => scope,
    check: () => {}
  })(
    { provider: 'claude', sessionId: 'session', uuid: 'tool' },
    incoming,
    { turnScope: scope },
    scope,
    1,
    undefined
  )
  return mutations
}

type ToolCall = Extract<AgentJournalItemBody, { kind: 'tool-call' }>

const call = (output: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  kind: 'tool-call',
  name: 'Bash',
  input: { command: 'ls' },
  state: 'completed',
  output: { head: output, byteLength: output.length, digest: output, truncated: false },
  ...extra
})

it('never revises a provider-finished output from its lossy source copy', () => {
  expect(project(call('live full output'), call('preview')).size).toBe(0)
})

it('still reconciles a call the host closed', () => {
  const closed = call('partial', { state: 'failed', endedAs: 'interrupted' })
  expect(project(closed, call('whole output')).size).toBe(1)
})
