import { expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import { structuredAgentSessionStatusSummary } from './structured-agent-session-status-summary'

function summaryOf(forkedFrom?: ReturnType<typeof agentSessionRecordFixture>['forkedFrom']) {
  const record = { ...agentSessionRecordFixture(), ...(forkedFrom ? { forkedFrom } : {}) }
  return structuredAgentSessionStatusSummary({
    sessionId: record.sessionId,
    session: { params: { location: record.location, provider: record.provider } },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary reads only the journal's last activity time.
    journal: { lastActivityAt: () => 5 } as AgentSessionJournal,
    record,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projected summary is spread through as it is.
    state: { summary: { status: 'idle' } } as unknown as StructuredAgentSessionStatusState,
    stopping: false,
    childWork: {},
    now: () => 9
  })
}

it('tells clients which chat a fork came from, and nothing about how it was cut', () => {
  const forked = summaryOf({
    sessionId: 'claude_parent_chat',
    itemId: 'claude:provider:answer-1',
    providerSessionId: 'provider-parent',
    forkPoint: 'leaf-1'
  })

  expect(forked.forkedFrom).toEqual({ sessionId: 'claude_parent_chat' })
  expect(summaryOf()).not.toHaveProperty('forkedFrom')
})
