// A chat whose agent this build no longer drives (its definition now names another transport) is
// still readable, but nothing offers to start it: no restart offer, and a recorded failure is not
// retryable. The offer itself is kept, so a build that drives the agent again offers it again.

import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'

afterEach(() => vi.restoreAllMocks())

/** This build's agents, with Codex now speaking a protocol its existing chats were not made in. */
function codexOnAnotherTransport(): StructuredAgentRegistry {
  return new StructuredAgentRegistry(
    NO_STRUCTURED_AGENTS.registrations().map((registration) =>
      registration.definition.agent === 'codex'
        ? {
            ...registration,
            definition: { ...registration.definition, handleTransport: 'codex-acp' }
          }
        : registration
    )
  )
}

it('does not offer to resume a chat whose agent this build no longer drives, and keeps the offer', async () => {
  const { host, root, acquire } = await interruptedRestart(
    undefined,
    undefined,
    undefined,
    codexOnAnotherTransport()
  )

  expect(await host.restartResume.list()).toEqual([])
  expect(await host.restartResume.continueAfterRestart(undefined, 'modal')).toMatchObject({
    resumed: [],
    continued: []
  })
  expect(acquire).not.toHaveBeenCalled()
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW + 1)).toHaveLength(1)
})

it('lists a recorded failure of such a chat as not retryable', async () => {
  const { host, root, marker } = await interruptedRestart(
    undefined,
    undefined,
    undefined,
    codexOnAnotherTransport()
  )
  const capsule = new AgentSessionRecoveryCapsule(root)
  await capsule.beginResume([marker!.sessionId], 'operation-a', NOW + 1)
  await capsule.failResume(
    'operation-a',
    [
      {
        sessionId: marker!.sessionId,
        failedAt: NOW + 1,
        outcome: 'refused',
        reason: 'structured_agent_session_unsupported',
        latestPrompt: '',
        latestUserItemId: null
      }
    ],
    NOW + 1
  )

  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: marker!.sessionId, retryable: false }
  ])
})
