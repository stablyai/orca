import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { deferred } from '../process/testing/acp-scripted-agent.test-support'
import { z } from 'zod'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import type { FakeFrame } from '../process/testing/acp-scripted-agent.test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

function configuration(currentValue = 'reviewer', plan = true): SessionConfigOption[] {
  return [
    ...GROK_CONFIG_OPTIONS,
    {
      id: 'agent-choice',
      name: 'Agent',
      category: 'mode',
      type: 'select',
      currentValue,
      options: [
        { value: 'build', name: 'Build' },
        ...(plan ? [{ value: 'plan', name: 'Plan' }] : []),
        { value: 'reviewer', name: 'Reviewer' }
      ]
    }
  ]
}

function current(configOptions: SessionConfigOption[], id: string): string {
  const option = configOptions.find((entry) => entry.id === id)
  if (option?.type !== 'select') {
    throw new Error(`No select option ${id}`)
  }
  return option.currentValue
}

function send(
  rig: AcpAdapterRig,
  clientMessageId: string,
  executionOptions?: AgentSessionExecutionOptions,
  signal?: AbortSignal
) {
  return rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId,
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    executionOptions,
    signal
  })
}

it('runs messages in their captured agent before applying model and effort', async () => {
  let configOptions = configuration()
  const controls: unknown[] = []
  const executions: unknown[] = []
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode2')!,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
      )
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = z
          .object({ configId: z.string(), value: z.string() })
          .parse(frame.params)
        controls.push({ configId, value })
        configOptions = configId === 'agent-choice' ? configuration(value) : configOptions
        configOptions = configOptions.map((option) =>
          option.type === 'select' && option.id === configId
            ? { ...option, currentValue: value }
            : option
        )
        if (configId === 'agent-choice') {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: { sessionUpdate: 'current_mode_update', currentModeId: value }
          })
        }
        agent.reply(frame, { configOptions })
      })
      agent.on('session/prompt', (frame) => {
        executions.push({
          agent: current(configOptions, 'agent-choice'),
          model: current(configOptions, 'model'),
          effort: current(configOptions, 'reasoning_effort')
        })
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    }
  })
  await rig.acquire()
  expect(await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })).toMatchObject({
    interactionModes: ['default', 'plan'],
    current: { reportedAgent: { id: 'reviewer', name: 'Reviewer' } }
  })
  await send(rig, 'native')
  await rig.settle()
  await send(rig, 'plan', { interactionMode: 'plan', model: 'grok-4.6', effort: 'low' })
  await rig.settle()
  await send(rig, 'build', { interactionMode: 'default', model: 'grok-4.6', effort: 'low' })
  await rig.settle()
  expect(executions).toEqual([
    { agent: 'reviewer', model: 'grok-4.7', effort: 'high' },
    { agent: 'plan', model: 'grok-4.6', effort: 'low' },
    { agent: 'build', model: 'grok-4.6', effort: 'low' }
  ])
  expect(controls).toEqual([
    { configId: 'agent-choice', value: 'plan' },
    { configId: 'model', value: 'grok-4.6' },
    { configId: 'reasoning_effort', value: 'low' },
    { configId: 'agent-choice', value: 'build' },
    { configId: 'model', value: 'grok-4.6' },
    { configId: 'reasoning_effort', value: 'low' }
  ])

  configOptions = configuration('reviewer')
  rig.child().agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'reviewer' }
  })
  await rig.settle()
  expect(await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })).toMatchObject({
    current: { reportedAgent: { id: 'reviewer', name: 'Reviewer' } }
  })
  await send(rig, 'restored-build', { interactionMode: 'default' })
  await rig.settle()
  expect(executions.at(-1)).toMatchObject({ agent: 'build' })
})

it('leaves a running answer in Build until the Plan message can start', async () => {
  let configOptions = configuration('build')
  const executions: string[] = []
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode')!,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        configOptions = configuration(value)
        agent.reply(frame, { configOptions })
      })
      agent.on('session/prompt', () => executions.push(current(configOptions, 'agent-choice')))
    }
  })
  await rig.acquire()
  await send(rig, 'running-build', { interactionMode: 'default' })
  const first = await rig.frame('session/prompt')
  const next = send(rig, 'waiting-plan', { interactionMode: 'plan' })
  await rig.settle()
  expect(current(configOptions, 'agent-choice')).toBe('build')
  expect(rig.sent('session/cancel')).toEqual([])
  rig.child().agent.reply(first, { stopReason: 'end_turn' })
  await expect(next).resolves.toEqual({ state: 'admitted' })
  await rig.frame('session/prompt', 1)
  expect(executions).toEqual(['build', 'plan'])
})

async function expectPlanRejection(
  result: Promise<unknown>,
  problem: 'unavailable' | 'unconfirmed' | 'failed'
): Promise<void> {
  const error: unknown = await result.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(AgentSessionOptionRejectedError)
  expect(error).toMatchObject({
    refusalReason: 'optionRejected',
    rejection: { kind: 'interactionModeFailed', interactionMode: { mode: 'plan', problem } }
  })
}

it.each([
  { response: 'unavailable', problem: 'unavailable' },
  { response: 'refused', problem: 'failed' },
  { response: 'unconfirmed', problem: 'unconfirmed' }
] as const)(
  'refuses a plan message when its switch is $response',
  async ({ response, problem }) => {
    const configOptions = configuration('reviewer', response !== 'unavailable')
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      script: (agent) => {
        agent.on('session/new', (frame) =>
          agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
        )
        agent.on('session/set_config_option', (frame) => {
          if (response === 'refused') {
            agent.fail(frame, -32602, 'Plan is disabled')
          } else {
            agent.reply(frame, { configOptions })
          }
        })
      }
    })
    await rig.acquire()
    await expectPlanRejection(send(rig, 'must-not-run', { interactionMode: 'plan' }), problem)
    expect(rig.sent('session/prompt')).toEqual([])
    expect(await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })).toMatchObject({
      current: { reportedAgent: { id: 'reviewer', name: 'Reviewer' } }
    })
    if (response === 'unconfirmed') {
      expect(rig.lifecycle.findLast((event) => event.type === 'options-reported')).toMatchObject({
        reportedOptions: { reportedAgent: { id: 'reviewer', name: 'Reviewer' } },
        interactionModes: ['default', 'plan']
      })
    }
  }
)

it.each(['rpc', 'local'] as const)(
  'retires an uncertain mode switch after its %s deadline before allowing another prompt',
  async (deadline) => {
    let configOptions = configuration('build')
    let held: FakeFrame | undefined
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      deps: { optionWriteTimeoutMs: 1_000 },
      script: (agent) => {
        agent.on('session/new', (frame) =>
          agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
        )
        agent.on('session/set_config_option', (frame) => {
          held = frame
        })
      }
    })
    await rig.acquire()
    const child = rig.child()
    child.proveClose = async () => false
    const setConfigOption = child.setConfigOption.bind(child)
    vi.spyOn(child, 'setConfigOption').mockImplementation((id, value, meta, received) =>
      setConfigOption(id, value, meta, received, deadline === 'rpc' ? 500 : 2_000)
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rejected = expectPlanRejection(
      send(rig, 'timed-out-plan', { interactionMode: 'plan' }),
      'failed'
    )
    await rig.frame('session/set_config_option')
    await vi.advanceTimersByTimeAsync(deadline === 'rpc' ? 500 : 1_000)
    await rejected
    expect(child.exited).toBe(false)
    configOptions = configuration('plan')
    child.agent.reply(held!, { configOptions })
    expect(await send(rig, 'unsafe-follow-up', { interactionMode: 'default' })).toMatchObject({
      state: 'rejected'
    })
    expect(rig.sent('session/prompt')).toEqual([])
    child.exit()
  }
)

it('waits for a withdrawn plan switch before executing the next message in Build', async () => {
  let held: FakeFrame | undefined
  let configOptions = configuration('build')
  const executions: string[] = []
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode')!,
    deps: { optionWriteTimeoutMs: 10_000 },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        configOptions = configuration(value)
        if (!held) {
          held = frame
        } else {
          agent.reply(frame, { configOptions })
        }
      })
      agent.on('session/prompt', (frame) => {
        executions.push(current(configOptions, 'agent-choice'))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    }
  })
  await rig.acquire()
  const withdrawn = new AbortController()
  const first = send(rig, 'withdrawn', { interactionMode: 'plan' }, withdrawn.signal)
  await rig.frame('session/set_config_option')
  withdrawn.abort(new Error('withdrawn'))
  await expect(first).rejects.toThrow('withdrawn')
  const second = send(rig, 'next', { interactionMode: 'default' })
  await rig.settle()
  expect(executions).toEqual([])
  rig.child().agent.reply(held!, { configOptions })
  await expect(second).resolves.toEqual({ state: 'admitted' })
  await rig.settle()
  expect(executions).toEqual(['build'])
})

it('reapplies the message mode after loading a conversation whose agent is different', async () => {
  let configOptions = configuration('reviewer')
  const executions: string[] = []
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode2')!,
    launch: {
      resume: {
        sessionId: PROVIDER_SESSION,
        key: 'acp:opencode2:saved',
        mayBeUnsaved: async () => false,
        lossKeys: []
      }
    },
    script: (agent) => {
      agent.on('session/load', (frame) => agent.reply(frame, { configOptions }))
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        configOptions = configuration(value)
        agent.reply(frame, { configOptions })
      })
      agent.on('session/prompt', (frame) => {
        executions.push(current(configOptions, 'agent-choice'))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    }
  })
  await rig.acquire({ options: { interactionMode: 'plan' } })
  expect(rig.sent('session/set_config_option')).toEqual([])
  await send(rig, 'resume-plan', { interactionMode: 'plan' })
  await rig.settle()
  expect(executions).toEqual(['plan'])
})

it('refuses a Plan prompt and reports Build when the model response changes its agent', async () => {
  let configOptions = configuration('build')
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode2')!,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
      )
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = z
          .object({ configId: z.string(), value: z.string() })
          .parse(frame.params)
        configOptions = configuration(configId === 'agent-choice' ? value : 'build')
        configOptions = configOptions.map((option) =>
          option.type === 'select' && option.id === configId
            ? { ...option, currentValue: value }
            : option
        )
        agent.reply(frame, { configOptions })
      })
    }
  })
  await rig.acquire()
  await expectPlanRejection(
    send(rig, 'drifting-model', { interactionMode: 'plan', model: 'grok-4.6' }),
    'unconfirmed'
  )
  expect(rig.sent('session/prompt')).toEqual([])
  expect(rig.lifecycle.findLast((event) => event.type === 'options-reported')).toMatchObject({
    reportedOptions: { reportedAgent: { id: 'build', name: 'Build' }, model: 'grok-4.6' },
    interactionModes: ['default', 'plan']
  })
})

it.each(['beforeDispatch', 'admission'] as const)(
  'checks the mode after an asynchronous %s boundary',
  async (boundary) => {
    let configOptions = configuration('build')
    const entered = deferred<void>()
    const gate = deferred<void>()
    const wait = async () => {
      entered.resolve()
      await gate.promise
    }
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      script: (agent) => {
        agent.on('session/new', (frame) =>
          agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
        )
        agent.on('session/set_config_option', (frame) => {
          const { value } = z.object({ value: z.string() }).parse(frame.params)
          configOptions = configuration(value)
          agent.reply(frame, { configOptions })
        })
      }
    })
    await rig.acquire()
    const sending = rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'gated-plan',
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'gated plan' }] },
      executionOptions: { interactionMode: 'plan' },
      beforeDispatch: boundary === 'beforeDispatch' ? wait : undefined,
      admitFreshInput:
        boundary === 'admission'
          ? async (enqueue) => {
              await wait()
              return enqueue('own', false)
            }
          : undefined
    })
    const rejected = expectPlanRejection(sending, 'unconfirmed')
    await entered.promise
    configOptions = configuration('build')
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'config_option_update', configOptions }
    })
    await rig.settle()
    gate.resolve()
    await rejected
    expect(rig.sent('session/prompt')).toEqual([])
  }
)

it('rejects a cached Plan selection after that choice is removed despite its current value', async () => {
  let configOptions = configuration('build')
  const executions: string[] = []
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode2')!,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        configOptions = configuration(value)
        agent.reply(frame, { configOptions })
      })
      agent.on('session/prompt', (frame) => {
        executions.push(current(configOptions, 'agent-choice'))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    }
  })
  await rig.acquire()
  await send(rig, 'first-plan', { interactionMode: 'plan' })
  await rig.settle()
  configOptions = configuration('plan', false)
  rig.child().agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'config_option_update', configOptions }
  })
  await rig.settle()
  await expectPlanRejection(send(rig, 'removed-plan', { interactionMode: 'plan' }), 'unavailable')
  expect(executions).toEqual(['plan'])
})

it('publishes absent agent evidence when a mode response omits the mode configuration', async () => {
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode2')!,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: configuration() })
      )
      agent.on('session/set_config_option', (frame) =>
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      )
    }
  })
  await rig.acquire()
  await expectPlanRejection(
    send(rig, 'unconfirmed-plan', { interactionMode: 'plan' }),
    'unconfirmed'
  )
  const lastReport = rig.lifecycle.findLast((event) => event.type === 'options-reported')
  expect(lastReport?.reportedOptions.reportedAgent).toBeUndefined()
  expect(lastReport?.interactionModes).toEqual([])
  expect(rig.sent('session/prompt')).toEqual([])
})

it.each([
  { control: 'agent-choice', notification: 'current_mode_update' },
  { control: 'model', notification: 'config_option_update' }
] as const)(
  'keeps newer $notification evidence when a held $control response arrives late',
  async ({ control, notification }) => {
    let configOptions = configuration('build')
    const pending = deferred<{ frame: FakeFrame; configOptions: SessionConfigOption[] }>()
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      script: (agent) => {
        agent.on('session/new', (frame) =>
          agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
        )
        agent.on('session/set_config_option', (frame) => {
          const { configId, value } = z
            .object({ configId: z.string(), value: z.string() })
            .parse(frame.params)
          configOptions = configId === 'agent-choice' ? configuration(value) : configOptions
          configOptions = configOptions.map((option) =>
            option.type === 'select' && option.id === configId
              ? { ...option, currentValue: value }
              : option
          )
          if (configId === control) {
            pending.resolve({ frame, configOptions })
          } else {
            agent.reply(frame, { configOptions })
          }
        })
      }
    })
    await rig.acquire()
    const rejected = expectPlanRejection(
      send(rig, 'stale-plan-snapshot', {
        interactionMode: 'plan',
        ...(control === 'model' ? { model: 'grok-4.6' } : {})
      }),
      'unconfirmed'
    )
    const held = await pending.promise
    configOptions = configuration('build')
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update:
        notification === 'current_mode_update'
          ? { sessionUpdate: 'current_mode_update', currentModeId: 'build' }
          : { sessionUpdate: 'config_option_update', configOptions }
    })
    await rig.settle()
    rig.child().agent.reply(held.frame, { configOptions: held.configOptions })
    await rejected
    expect(rig.sent('session/prompt')).toEqual([])
    expect(await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })).toMatchObject({
      current: { reportedAgent: { id: 'build', name: 'Build' } }
    })
    expect(rig.lifecycle.findLast((event) => event.type === 'options-reported')).toMatchObject({
      reportedOptions: { reportedAgent: { id: 'build', name: 'Build' } }
    })
  }
)
