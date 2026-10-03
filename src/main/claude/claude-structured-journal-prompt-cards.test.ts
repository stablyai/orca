// A subagent's prompt card counts as open once its rows land, until anyone closes or takes it over.

import { describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionSinkBarrier } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

const PROMPT: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }> = {
  type: 'prompt',
  sessionId: 'session-1',
  prompt: {
    requestId: 'req-1',
    promptKey: 'req-1',
    toolUseId: 'toolu-1',
    toolName: 'Bash',
    kind: 'approval',
    input: { command: 'touch f' },
    suggestions: [],
    questionIds: [],
    settle: vi.fn()
  }
}

function cards(options: { accepted?: boolean; asker?: string } = {}) {
  let land: (barrier: StructuredAgentSessionSinkBarrier) => void = () => {}
  const prompts = new ClaudeJournalPrompts({
    sink: {
      appendItem: () => {},
      tryAppendItem: () =>
        options.accepted === false
          ? { accepted: false, reason: 'backpressure' }
          : { accepted: true },
      appendTombstone: () => {},
      publish: () => {},
      written: () =>
        new Promise((resolve) => {
          land = resolve
        })
    },
    turnScope: () => AGENT_JOURNAL_THREAD_SCOPE,
    producerOf: () =>
      options.asker === undefined ? {} : { agentId: options.asker, producerKind: 'agent' }
  })
  prompts.handle(PROMPT)
  const open = () => [...prompts.openCards()]
  const landed = async (barrier: StructuredAgentSessionSinkBarrier = { ok: true }) => {
    const written = prompts.whenWritten('req-1')
    land(barrier)
    await written
  }
  return {
    prompts,
    open,
    landed,
    land: (barrier: StructuredAgentSessionSinkBarrier) => land(barrier)
  }
}

describe("a subagent's prompt card", () => {
  it('never opens when the sink refused its rows or failed writing them', async () => {
    const refused = cards({ asker: 'agent-1', accepted: false })
    await refused.landed()
    expect(refused.open()).toEqual([])
    const failed = cards({ asker: 'agent-1' })
    await failed.landed({ ok: false, error: new Error('write failed') })
    expect(failed.open()).toEqual([])
  })

  it('opens a card handed back before its rows landed once they land', async () => {
    const { prompts, open, land } = cards({ asker: 'agent-1' })
    const written = prompts.whenWritten('req-1')
    const handBack = prompts.handOver('req-1')
    handBack()
    land({ ok: true })
    await written
    expect(open()).toEqual([{ promptKey: 'req-1', asker: 'agent-1' }])
  })
})
