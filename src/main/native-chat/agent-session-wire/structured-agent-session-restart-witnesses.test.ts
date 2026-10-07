import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import { marker } from './structured-agent-session-restart-resume-test-harness'

// Every stopped session counts as cut off; what is under test is which witnesses a clear drops.
vi.mock('./structured-agent-session-working-at-teardown', () => ({
  structuredAgentSessionWorkingAtStop: (input: { sessionId: string; now: number }) =>
    marker({ sessionId: input.sessionId, recordedAt: input.now })
}))

const AGENTS: Record<string, string> = { 'codex-chat': 'codex', 'grok-chat': 'grok' }

function witnessed() {
  const recorded: AgentSessionResumeMarker[][] = []
  const witnesses = createStructuredAgentSessionRestartWitnesses({
    sessions: new Map(),
    getRecord: (sessionId) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: clear reads only the record's provider.
      AGENTS[sessionId] ? ({ provider: AGENTS[sessionId] } as AgentSessionRecord) : null,
    childWork: () => undefined,
    startAnswered: () => undefined,
    capsule: { record: async (markers) => void recorded.push([...markers]) },
    teardownId: 'teardown',
    now: () => 1,
    enqueue: (operation) => operation()
  })
  witnesses.begin('quit')
  for (const sessionId of ['codex-chat', 'grok-chat', 'unreadable-chat']) {
    witnesses.beforeStop(sessionId)
    witnesses.stopped(sessionId)
  }
  const written = async () => {
    await witnesses.record()
    return (recorded.at(-1) ?? []).map((each) => each.sessionId)
  }
  return { witnesses, written }
}

describe('restart witnesses', () => {
  it('drops every unwritten witness on an unscoped clear', async () => {
    const { witnesses, written } = witnessed()
    witnesses.clear()
    expect(await written()).toEqual([])
  })

  it('drops only the witnesses of agents the audience sees on a scoped clear', async () => {
    const { witnesses, written } = witnessed()
    witnesses.clear((agent) => agent !== 'grok')
    expect(await written()).toEqual(['grok-chat', 'unreadable-chat'])
  })
})
