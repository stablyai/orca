import { expect, it, vi } from 'vitest'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { toolUse, toolResult } from '../../claude/structured/claude-foreground-task-test-support'
import { HOST_TEST_SESSION as SESSION } from './host/testing/structured-agent-session-host-test-data.test-fixture'
import { fixture } from './host/testing/structured-agent-session-claude-stop-contract.test-fixture'
import { openTurn } from './host/testing/structured-agent-session-claude-stop-contract-test-actions.test-fixture'

it('delivers a running root Bash action before its result and removes it when it ends', async () => {
  const connection = fixture.claude.connections[0]!
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
    await vi.waitFor(() =>
      expect(pane.backgroundTasks?.foregroundTasks).toMatchObject([{ toolUseId: 'toolu_build' }])
    )
    connection.handlers.onMessage?.(toolResult('toolu_build', 'Build passed'))
    await fixture.host.flushStreamedEvents(SESSION)
    await vi.waitFor(() => expect(pane.backgroundTasks?.foregroundTasks ?? []).toEqual([]))
  } finally {
    close()
  }
})
