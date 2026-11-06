import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { AcpAgentError } from './acp-errors'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { applyAcpMessageOptions } from './acp-message-execution-options'
import { acpNoModelSelected, withAcpModelFallback } from './acp-model-command'
import { writeAcpSessionOption } from './acp-session-option-write'
import type { AcpSessionEvent } from './acp-session-runtime'
import { AcpStructuredOptions } from './acp-structured-options'
import { routeAcpSessionEvent, type AcpStructuredSession } from './acp-structured-session'
import type { SessionConfigOption, SessionUpdate } from './generated/acp-protocol.generated'

const config = (model: string, thinking: string): SessionConfigOption[] => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: 'p/a', name: 'A' },
      { value: 'p/b', name: 'B' }
    ]
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: thinking,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' }
    ]
  }
]

// No turn runs and nothing stops, so the command never waits or withdraws.
const idleTurns = {
  running: false,
  withdrawalEpoch: 0,
  withdrawnSince: () => null,
  holdSteer: () => () => undefined
}

const event = (update: SessionUpdate): AcpSessionEvent => ({
  kind: 'known',
  notification: { sessionId: 'omp-1', update }
})

// OMP 18.15 `/model`: reply text, then its explicit config push, then end_turn (acp-agent.ts:1263-1295).
function rig(updates: SessionUpdate[], version = '18.15.0') {
  const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
  options.adoptSession({ configOptions: config('p/a', 'low') }, 'loaded')
  const lane = { translator: { sessionEvent: vi.fn(() => []) }, apply: vi.fn() }
  const prompt = vi.fn(async () => {
    for (const update of updates) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only the lane's translator and apply, which this fake provides.
      routeAcpSessionEvent({ lane, options } as never, event(update), 1)
    }
    return { stopReason: 'end_turn' }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send path reads only spec, options, the idle turns and connection.prompt/initialize, which this fake provides.
  const session = {
    spec: acpLaunchSpecFor('omp')!,
    options,
    turns: idleTurns,
    connection: { prompt, initialize: async () => ({ agentInfo: { name: 'omp', version } }) }
  } as unknown as AcpStructuredSession
  const send = (model: string) =>
    withAcpModelFallback(session, { agent: 'omp', timeoutMs: 1_000 }, (fallback) =>
      applyAcpMessageOptions(
        session,
        { model },
        async () => {
          throw new AcpAgentError(-32603, 'Internal error', {
            details: `Unknown ACP model: ${model}`
          })
        },
        () => true,
        undefined,
        fallback.command
      )
    )
  return { options, lane, prompt, send }
}

const reply = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text }
})
const pushed = (model: string, thinking: string): SessionUpdate => ({
  sessionUpdate: 'config_option_update',
  configOptions: config(model, thinking)
})

describe("OMP's own model command", () => {
  it('applies a role the model option refuses through /model, without anything reaching the chat', async () => {
    const { options, lane, prompt, send } = rig([
      reply('Model set to p/b.'),
      { sessionUpdate: 'session_info_update', title: 'chat' },
      pushed('p/b', 'high')
    ])
    await expect(send('@worker_be:high')).resolves.toBe(true)
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '/model @worker_be:high' }])
    expect(options.appliedInput.get('model')).toBe('@worker_be:high')
    // Only the config push reaches the lane; the reply and title notice belong to the command.
    expect(lane.translator.sessionEvent).toHaveBeenCalledTimes(1)
    expect(options.read().current.model).toBe('p/b')
  })

  it.each([
    ['18.15.0', "OMP couldn't use @worker_be. Pick another model and send again."],
    [
      '17.0.5',
      "OMP couldn't use @worker_be. Update OMP to 18.1.9 or later to keep it after a restart, or pick another model and send again."
    ]
  ])(
    "names the agent and the next step when OMP %s can't use the role, and leaves it unapplied",
    async (version, words) => {
      // A failure can follow the model's own switch; it still counts as not applied.
      const { options, send } = rig(
        [pushed('p/b', 'low'), reply('Failed to set model: prompt rebuild failed')],
        version
      )
      const error: AgentSessionOptionRejectedError = await send('@worker_be').catch((e) => e)
      expect(
        agentSessionFailureWords(error.rejection!, { surface: 'rejection', agentName: 'OMP' })
          .reason
      ).toBe(words)
      expect(options.appliedInput.has('model')).toBe(false)
    }
  )

  it('applies the role again on the next send once OMP moves off what it resolved to', async () => {
    const { options, prompt, send } = rig([reply('Model set to p/b.'), pushed('p/b', 'high')])
    await send('@worker_be:high')
    // Its own late echo is not a change; the role stays applied.
    options.adoptConfigOptions(config('p/b', 'high'))
    await send('@worker_be:high')
    expect(prompt).toHaveBeenCalledTimes(1)
    // Native `/model p/b:low`: same model, other thinking, so the selector no longer holds.
    options.adoptConfigOptions(config('p/b', 'low'))
    await send('@worker_be:high')
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('does not re-send a role the session already runs from its launch line', async () => {
    const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
    options.adoptSession({ configOptions: config('p/a', 'low') }, 'new')
    options.adoptLaunchModel('@worker_be')
    const setOption = vi.fn(async () => undefined)
    const command = vi.fn(async () => undefined)
    await expect(
      applyAcpMessageOptions(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with the effort write accepted, the send path reads only session.options.
        { options } as unknown as AcpStructuredSession,
        { model: '@worker_be', effort: 'medium' },
        setOption,
        () => true,
        undefined,
        command
      )
    ).resolves.toBe(true)
    expect(setOption.mock.calls).toEqual([['effort', 'medium']])
    expect(command).not.toHaveBeenCalled()
  })

  it('retires launch-line proof on a native model change, but keeps ordinary control proof', async () => {
    const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
    options.adoptSession({ configOptions: config('p/a', 'high') }, 'new')
    options.adoptLaunchModel('@worker_be')
    // The launch line already applied the role, so the first send writes nothing for it.
    expect(options.appliedInput.get('model')).toBe('@worker_be')
    options.adoptConfigOptions(config('p/b', 'high'))
    expect(options.appliedInput.has('model')).toBe(false)
    // A successful model option write keeps the shipped rule: observations never override it.
    await writeAcpSessionOption(
      {
        setConfigOption: async () => ({ configOptions: config('p/a', 'high') }),
        setModel: vi.fn()
      },
      options,
      options.write('model', 'p/a')!,
      { agent: 'omp', key: 'model', value: 'p/a', timeoutMs: 1_000 }
    )
    options.adoptConfigOptions(config('p/b', 'low'))
    expect(options.appliedInput.get('model')).toBe('p/a')
  })

  it.each(['aborted', 'timed out'] as const)(
    'leaves the role unapplied and retires OMP when the command is %s',
    async (ending) => {
      const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
      options.adoptSession({ configOptions: config('p/a', 'low') }, 'loaded')
      const late = Promise.withResolvers<void>()
      const retired = vi.fn()
      const aborted = new AbortController()
      // A genuine late success: OMP's reply, its config push and a normal end, after Orca gave up.
      const prompt = async () => {
        await late.promise
        options.commandReply += 'Model set to p/b.'
        options.adoptConfigOptions(config('p/b', 'low'))
        return { stopReason: 'end_turn' }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the command reads only spec, options, the idle turns and connection.prompt, which this fake provides.
      const session = {
        spec: acpLaunchSpecFor('omp')!,
        options,
        turns: idleTurns,
        connection: { prompt }
      } as unknown as AcpStructuredSession
      const bound = {
        agent: 'omp',
        timeoutMs: ending === 'timed out' ? 1 : 1_000,
        signal: aborted.signal,
        onUncertain: retired
      }
      const pending = withAcpModelFallback(session, bound, (fallback) =>
        fallback.command!('@worker_be')
      )
      if (ending === 'aborted') {
        aborted.abort()
      }
      await expect(pending).rejects.toThrow()
      expect(retired).toHaveBeenCalledOnce()
      // A late success cannot restore proof the abort retired.
      late.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(options.appliedInput.has('model')).toBe(false)
      expect(options.writing).toBe(0)
    }
  )

  it('says a cancelled command left the message unsent', async () => {
    const cancelled = rig([])
    cancelled.prompt.mockResolvedValue({ stopReason: 'cancelled' })
    const error: AgentSessionOptionRejectedError = await cancelled
      .send('@worker_be')
      .catch((e) => e)
    expect(error.rejection).toMatchObject({ kind: 'cancelled', neverReachedAgent: true })
  })

  it('says OMP had no model, not that it is signed out, and applies the role again next send', async () => {
    const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
    // A typo'd launch role: OMP defers it, never resolves it, and still lists models[0] as current.
    options.adoptSession({ configOptions: config('p/a', 'low') }, 'new')
    options.adoptLaunchModel('@worker_bee')
    // OMP's prompt error with no model (agent-session.ts), the same text a signed-out OMP gives.
    const noModel = new AcpAgentError(-32603, 'Internal error', {
      details:
        'No model selected.\n\nUse /login, set an API key environment variable, or create ~/.omp/agent/models.yml\n\nThen use /model to select a model.'
    })
    // OMP's own text stays in the log only; the user sees Orca's sentence.
    expect(acpNoModelSelected(OMP_ACP_DIALECT, options, noModel)).toEqual({
      kind: 'modelNotSelected',
      detail: { audience: 'log', text: expect.stringContaining('No model selected.') }
    })
    expect(OMP_ACP_DIALECT.authenticationRequired!(noModel)).toBe(false)
    // The saved selection stays; its proof is gone, so the next send writes it again.
    const setOption = vi.fn(async () => undefined)
    await applyAcpMessageOptions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with the write accepted, the send path reads only session.options.
      { options } as unknown as AcpStructuredSession,
      { model: '@worker_bee' },
      setOption,
      () => true
    )
    expect(setOption).toHaveBeenCalledWith('model', '@worker_bee')
    // An explicit missing key is still a sign-in problem.
    const noKey = new AcpAgentError(-32603, 'Internal error', {
      details: 'No API key found for openai.\n\nUse /login'
    })
    expect(acpNoModelSelected(OMP_ACP_DIALECT, options, noKey)).toBeUndefined()
    expect(OMP_ACP_DIALECT.authenticationRequired!(noKey)).toBe(true)
  })
})
