import { expect, it } from 'vitest'
import { AGENT_SESSION_EXECUTION_VIEW_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import { projectExecutionStatusEvent } from './structured-agent-session-execution-capability'
const event: AgentSessionStatusEvent = {
  type: 'status',
  session: {
    sessionId: 'session',
    workspaceId: 'folder',
    agent: 'codex',
    status: 'attention',
    latestPrompt: 'hello',
    updatedAt: 1,
    execution: {
      sessionId: 'session',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceKind: 'folder',
        workspaceId: 'folder'
      },
      hostIncarnation: 'host',
      revision: 1,
      fence: 2,
      cursor: { epoch: 'e', sequence: 2 },
      observation: 'unverifiable',
      activity: 'unverifiable',
      control: 'none',
      turnId: null,
      promptIds: [],
      recovery: true,
      historicalStatus: 'working'
    }
  }
}
it('gates changed status content while retaining existing frame shapes', () => {
  expect(
    projectExecutionStatusEvent(event, { clientKind: 'runtime', clientCapabilities: [] })
  ).toMatchObject({ type: 'status', session: { status: 'working' } })
  expect(
    projectExecutionStatusEvent(event, {
      clientKind: 'runtime',
      clientCapabilities: [AGENT_SESSION_EXECUTION_VIEW_CAPABILITY]
    })
  ).toBe(event)
  expect(projectExecutionStatusEvent(event, {})).toBe(event)
})
