import { openAcpAdapterRig } from './acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { afterEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PROVIDER_EXIT_OUTPUT_DRAIN_MS } from '../provider-process/provider-exit-output-drain'
import { createAcpAgentConnection } from './acp-agent-connection'
import { AcpAgentError, AcpRequestTimeoutError } from './acp-errors'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { acpReopenTakeover } from './acp-session-reopen-failure'

it.each(['ServerUnavailable', 'CatalogNotReady'])(
  'retains the saved session on a temporary %s load answer',
  async (errorName) => {
    const error = new AcpAgentError(-32603, 'not ready', { errorName })
    const warn = vi.fn()
    await expect(
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
    ).rejects.toThrow(error)
    expect(warn).not.toHaveBeenCalled()
  }
)

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

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

it.each([
  { agent: 'exited while its output drained', exits: true },
  { agent: 'is still running', exits: false }
])("keeps a load deadline's words when the agent $agent", async ({ exits }) => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  const spawned: ReturnType<typeof createFakePipedChild>[] = []
  const agents: AcpScriptedAgent[] = []
  const rig = await openAcpAdapterRig({
    launch: {
      resume: {
        key: 'saved-key',
        sessionId: 'saved-id',
        mayBeUnsaved: () => false,
        unannouncedLosses: () => []
      }
    },
    deps: {
      connect: (launch, options) => {
        const agent = new AcpScriptedAgent()
        agent.on('initialize', (frame) =>
          agent.reply(frame, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
        )
        // The agent never answers the load, but would open a replacement session.
        agent.on('session/load', () => {})
        agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'replacement-id' }))
        const child = Object.assign(createFakePipedChild(), {
          pid: 9_999_999,
          stdout: agent.stdout,
          stdin: agent.stdin,
          stderr: new PassThrough(),
          kill: () => true
        })
        // A live agent exits when Orca closes its input.
        agent.stdin.once('finish', () => {
          if (!exits) {
            child.emit('exit', 0, null)
          }
        })
        spawned.push(child)
        agents.push(agent)
        return createAcpAgentConnection(launch, options, () => child)
      }
    }
  })
  try {
    const acquired = rig.acquire()
    await vi.waitFor(() =>
      expect(agents[0]?.frames.some((frame) => frame.method === 'session/load')).toBe(true)
    )
    await vi.advanceTimersByTimeAsync(299_500)
    // An exiting agent leaves unanswered at 299.5 s, holding stdout open; the load's own deadline
    // fires at 300 s, inside the output drain that the exit started.
    if (exits) {
      spawned[0].emit('exit', 1, null)
    }
    await vi.advanceTimersByTimeAsync(500 + PROVIDER_EXIT_OUTPUT_DRAIN_MS)
    // No replacement session is opened, even in a live agent that would answer one.
    expect(agents[0].frames.map((frame) => frame.method)).not.toContain('session/new')
    await acquired
    const timedOut = agentSessionFailureFact('startFailed', {
      requestTimeout: { method: 'session/load', timeoutMs: 300_000 }
    })
    expect(rig.openVerdict()).toMatchObject({ retry: 'never', fact: timedOut })
    expect(rig.openFailure()).toBeInstanceOf(AcpRequestTimeoutError)
    expect(agentSessionFailureWords(rig.openVerdict()!.fact, { surface: 'rejection' })).toEqual(
      agentSessionFailureWords(timedOut, { surface: 'rejection' })
    )
    expect(spawned).toHaveLength(1)
  } finally {
    for (const child of spawned) {
      child.stdout.end()
      child.stderr.end()
    }
    await rig.adapter.closeAll()
  }
})
