import { expect, it } from 'vitest'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/agent-session/structured-agent-session-reducer'
import { toolUse, toolResult } from '../../claude/claude-child-work-producer-harness.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { fixture } from './structured-agent-session-claude-stop-contract-test-fixture'
import { openTurn } from './structured-agent-session-claude-stop-contract-test-actions'

it('delivers a running root Bash action before its result and removes it when it ends', async () => {
  const connection = fixture.claude.connections[0]!
  connection.backgroundTasks = async () => true
  await openTurn(connection)
  let pane: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  const close = await fixture.host.subscribe({
    id: 'foreground-pane',
    sessionId: SESSION,
    emit: (event) => {
      pane = reduceStructuredAgentSession(pane, { type: 'event', event })
    }
  })
  try {
    connection.handlers.onMessage?.(toolUse('toolu_build', 'Bash', { command: 'pnpm build' }))
    await fixture.host.flushStreamedEvents(SESSION)
    expect(pane.backgroundTasks?.foregroundTasks).toMatchObject([{ toolUseId: 'toolu_build' }])
    connection.handlers.onMessage?.(toolResult('toolu_build', 'Build passed'))
    await fixture.host.flushStreamedEvents(SESSION)
    expect(pane.backgroundTasks?.foregroundTasks ?? []).toEqual([])
  } finally {
    close()
  }
})
