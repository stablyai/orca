import { openAcpAdapterRig } from './acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { afterEach, expect, it, vi } from 'vitest'
import { AcpAgentError, AcpRequestTimeoutError } from './acp-errors'
import { openAcpStart } from './acp-structured-start-open'
import { AgentSessionStartFailure } from '../native-chat/agent-session-wire/structured-agent-session-start-failure'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { acpReopenTakeover } from './acp-session-reopen-failure'

it.each(['ServerUnavailable', 'CatalogNotReady'])(
  'retains the saved session on a temporary %s load answer',
  (errorName) => {
    const error = new AcpAgentError(-32603, 'not ready', { errorName })
    const warn = vi.fn()
    expect(() =>
      acpReopenTakeover(
        error,
        {
          key: 'saved-key',
          sessionId: 'saved-id',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        },
        { over: false, now: 1, warn }
      )
    ).toThrow(error)
    expect(warn).not.toHaveBeenCalled()
  }
)

afterEach(closeProviderTimelineRigs)

it('propagates a temporary load envelope before takeover or a dead-child assertion can replace it', async () => {
  const rig = await openAcpAdapterRig({
    launch: {
      resume: {
        key: 'saved-key',
        sessionId: 'saved-id',
        mayBeUnsaved: () => false,
        unannouncedLosses: () => []
      }
    },
    script: (agent) =>
      agent.on('session/load', (frame) =>
        agent.fail(frame, -32603, 'server unavailable', { errorName: 'ServerUnavailable' })
      )
  })
  await rig.acquire()
  // The adapter answers for its own declared-temporary answer, which it keeps as the cause.
  expect(rig.openVerdict()).toMatchObject({ retry: 'safe' })
  expect(rig.openFailure()).toBeInstanceOf(AcpAgentError)
  expect(rig.openFailure()).toMatchObject({ data: { errorName: 'ServerUnavailable' } })
  expect(rig.sent('session/new')).toEqual([])
  expect(rig.sent('session/load')[0].params).toMatchObject({ sessionId: 'saved-id' })
  await rig.adapter.closeAll()
})

it("keeps a load deadline's words when the agent exited while its output drained", async () => {
  const timeout = new AcpRequestTimeoutError('session/load', 300_000)
  // The agent exited unanswered at 299.5 s; the request's own deadline fired while its output drained.
  const child = {
    fence: 3,
    acquisitionGeneration: 'g1',
    ended: false,
    closeRequested: false,
    connection: { exited: true },
    spec: { agent: 'opencode', dialect: 'opencode' },
    open: async () => {
      throw timeout
    }
  }
  const failure = await openAcpStart(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openAcpStart reads only the starting child's fields set above.
    { sessions: new Map([['s1', child]]) } as unknown as Parameters<typeof openAcpStart>[0],
    { sessionId: 's1', fence: 3, acquisitionGeneration: 'g1', signal: new AbortController().signal }
  ).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    retry: 'never',
    fact: { kind: 'startFailed', requestTimeout: { method: 'session/load', timeoutMs: 300_000 } }
  })
  if (!(failure instanceof AgentSessionStartFailure)) {
    throw new Error('the open did not fail with its verdict')
  }
  expect(agentSessionFailureWords(failure.fact, { surface: 'rejection' })).toEqual(
    agentSessionFailureWords(
      agentSessionFailureFact('startFailed', {
        requestTimeout: { method: 'session/load', timeoutMs: 300_000 }
      }),
      { surface: 'rejection' }
    )
  )
})
