import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { CALLER } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { acpLaunchSpecFor } from './acp-launch-specs'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import { PROVIDER_SESSION, replyChunk, waitFor } from './acp-structured-adapter.test-support'
import { framesOf, launch, openHostRig, send } from './acp-structured-host.test-support'
import {
  SetSessionConfigOptionRequestSchema,
  type SessionConfigOption
} from './generated/acp-protocol.generated'

// OpenCode 2.0.21 cold-load capture: the current model is absent from the partial inventory.
const MODEL = 'existing_lb/gpt-6.1-sol'
const OTHER = 'opencode/beam-free'
const select = (id: string, category: string, currentValue: string): SessionConfigOption => ({
  id,
  name: id,
  category,
  type: 'select',
  currentValue,
  options:
    category === 'thought_level'
      ? [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' }
        ]
      : []
})
const config = (model = MODEL, modelId = 'model', effort?: string): SessionConfigOption[] => [
  select(modelId, 'model', model),
  ...(effort ? [select('variant', 'thought_level', effort)] : []),
  select('mode', 'mode', 'default')
]
const push = (configOptions: SessionConfigOption[], sessionId = PROVIDER_SESSION): FakeFrame => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions } }
})
const response = (frame: FakeFrame, configOptions: SessionConfigOption[]): FakeFrame => ({
  jsonrpc: '2.0',
  id: frame.id,
  result: { sessionId: PROVIDER_SESSION, configOptions }
})
const chunk = (agent: AcpScriptedAgent, frames: FakeFrame[]) =>
  agent.stdout.write(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)

afterEach(closeProviderTimelineRigs)

async function openModel(
  settings: {
    restored?: boolean
    agent?: 'opencode2' | 'omp'
    intent?: Record<string, string>
    permission?: boolean
    script?: (agent: AcpScriptedAgent, native: { model: string; effort: string }) => void
  } = {}
) {
  const base = acpLaunchSpecFor(settings.agent ?? 'opencode2')!
  const spec = settings.permission
    ? {
        ...base,
        permissionModeConfig: {
          values: { ask: 'default', 'accept-edits': 'auto_edit', 'full-access': 'yolo' }
        }
      }
    : base
  const native = { model: MODEL, effort: 'low' }
  let resumed = false
  const f = await openHostRig({
    spec,
    deps: { resolveLaunch: launch(() => resumed, spec) },
    script: (agent) => {
      for (const method of ['session/new', 'session/load', 'session/resume']) {
        agent.on(method, (frame) =>
          agent.reply(frame, {
            sessionId: PROVIDER_SESSION,
            configOptions: config()
          })
        )
      }
      agent.on('session/set_config_option', (frame) => {
        if (SetSessionConfigOptionRequestSchema.parse(frame.params).configId === 'mode') {
          agent.reply(frame, { configOptions: config() })
        } else {
          agent.fail(frame, -32602, 'Invalid params', `model not found: ${MODEL}`)
        }
      })
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', replyChunk('', `${native.model}:${native.effort}`))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
      if (resumed || settings.restored === false) {
        settings.script?.(agent, native)
      }
    }
  })
  const attach = (fence: number | null) =>
    f.host.attach(
      CALLER,
      hostTestAttachParams(fence, {
        provider: spec.agent,
        agent: spec.agent,
        accountHome:
          spec.agent === 'omp'
            ? { variable: 'PI_CODING_AGENT_DIR', path: '/acp-test' }
            : { kind: 'opencode', locator: { kind: 'unmanaged' } },
        providerHandle: undefined,
        options: settings.intent ?? { model: MODEL }
      })
    )
  expect(await attach(null)).toMatchObject({ ok: true })
  await f.ready()
  if (settings.restored !== false) {
    await f.host.close(SESSION, 'user-close')
    resumed = true
    expect(await attach(f.fence())).toMatchObject({ ok: true })
    await f.ready()
  }
  const reply = async (text: string, expected: string) => {
    const id = await send(f.host, text)
    await waitFor(async () => {
      expect(
        (await f.host.journalSnapshot(SESSION)).submissions.find(
          (entry) => entry.clientMessageId === id
        )
      ).toMatchObject({ dispatchState: 'accepted' })
      const messages = await f.messages()
      expect(
        messages,
        JSON.stringify({ messages, controls: framesOf(f.rig.child(), 'session/set_config_option') })
      ).toContain(expected)
      expect(f.host.collaboratorsForTests().sessions.get(SESSION)!.journal.runningTurn()).toBeNull()
    })
    return id
  }
  return { ...f, native, reply }
}

it.each(['opencode2', 'omp'] as const)(
  'resumes %s with its exact saved model outside the inventory for two replies',
  async (agent) => {
    const f = await openModel({ agent })
    await f.reply('first', 'existing_lb/gpt-6.1-sol:low')
    await f.reply('second', 'existing_lb/gpt-6.1-sol:low')
    expect(framesOf(f.rig.child(), 'session/prompt')).toHaveLength(2)
    await f.host.close(SESSION, 'user-close')
  }
)

it.each(['@role', '@role:high', 'retired'])(
  'preserves literal saved intent %j when the provider rejects it',
  async (model) => {
    const f = await openModel({ agent: 'omp', intent: { model } })
    const id = await send(f.host, 'literal choice')
    await waitFor(async () =>
      expect(
        (await f.host.journalSnapshot(SESSION)).submissions.find(
          (entry) => entry.clientMessageId === id
        )
      ).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(f.store.getRecord(SESSION)?.options?.model).toBe(model)
    expect(framesOf(f.rig.child(), 'session/prompt')).toHaveLength(0)
    await f.host.close(SESSION, 'user-close')
  }
)

it.each(['canonical', 'missing'] as const)(
  'retains successful literal alias proof with %s readback',
  async (echo) => {
    let applied = false
    const f = await openModel({
      intent: { model: 'alias' },
      script: (agent, native) => {
        agent.on('session/set_config_option', (frame) => {
          if (applied) {
            agent.fail(frame, -32602, 'Invalid params', 'alias cannot be resolved twice')
            return
          }
          expect(SetSessionConfigOptionRequestSchema.parse(frame.params).value).toBe('alias')
          applied = true
          native.model = 'resolved/provider-model'
          agent.reply(frame, { configOptions: echo === 'missing' ? [] : config(native.model) })
        })
      }
    })
    await f.reply('first', 'resolved/provider-model:low')
    await f.reply('second', 'resolved/provider-model:low')
    await f.host.close(SESSION, 'user-close')
  }
)

it('keeps explicit effort through an unoffered turn and applies it despite a fallback echo', async () => {
  const f = await openModel({
    intent: { model: MODEL, effort: 'high' },
    script: (agent, native) => {
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = SetSessionConfigOptionRequestSchema.parse(frame.params)
        if (configId !== 'variant') {
          agent.fail(frame, -32602, 'Invalid params', 'model not found')
          return
        }
        native.effort = String(value)
        agent.reply(frame, { configOptions: config(MODEL, 'model', 'high') })
      })
    }
  })
  await f.reply('while the model catalog loads', 'existing_lb/gpt-6.1-sol:low')
  expect(f.store.getRecord(SESSION)?.options?.effort).toBe('high')
  const offered = config(MODEL, 'model', 'high').map((option) =>
    option.id === 'variant'
      ? {
          ...option,
          options: [
            { value: 'high', name: 'High' },
            { value: 'default', name: 'Default' }
          ]
        }
      : option
  )
  f.rig.child().agent.notify('session/update', push(offered).params)
  await f.reply('apply the offered effort', 'existing_lb/gpt-6.1-sol:high')
  f.rig.child().agent.notify('session/update', push(config()).params)
  await f.reply('retain the model after effort was applied', 'existing_lb/gpt-6.1-sol:high')
  await f.host.close(SESSION, 'user-close')
})

it('reads the effort menu returned by an actual model change before the same prompt', async () => {
  const f = await openModel({
    intent: { model: OTHER, effort: 'high' },
    script: (agent, native) => {
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = SetSessionConfigOptionRequestSchema.parse(frame.params)
        if (configId === 'model') {
          native.model = String(value)
        } else if (configId === 'variant') {
          native.effort = String(value)
        }
        agent.reply(frame, { configOptions: config(OTHER, 'model', native.effort) })
      })
    }
  })
  await f.reply('change model and apply high', 'opencode/beam-free:high')
  await f.host.close(SESSION, 'user-close')
})

it('does not send when an offered effort control is genuinely rejected', async () => {
  const f = await openModel({
    intent: { model: MODEL, effort: 'high' },
    script: (agent) => {
      agent.on('session/load', (frame) =>
        agent.reply(frame, { configOptions: config(MODEL, 'model', 'high') })
      )
    }
  })
  const id = await send(f.host, 'use the offered effort')
  await waitFor(async () =>
    expect(
      (await f.host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === id
      )
    ).toMatchObject({ dispatchState: 'rejected' })
  )
  expect(framesOf(f.rig.child(), 'session/prompt')).toHaveLength(0)
  expect(f.store.getRecord(SESSION)?.options?.effort).toBe('high')
  await f.host.close(SESSION, 'user-close')
})

it.each(['response-push', 'push-response'] as const)(
  'reduces restored %s records in one chunk before dispatch',
  async (order) => {
    const f = await openModel({
      script: (agent, native) => {
        agent.on('session/load', (frame) => {
          native.model = order === 'response-push' ? OTHER : MODEL
          const records = [response(frame, config()), push(config(OTHER))]
          chunk(agent, order === 'response-push' ? records : records.toReversed())
        })
        if (order === 'response-push') {
          agent.on('session/set_config_option', (frame) => {
            native.model = String(SetSessionConfigOptionRequestSchema.parse(frame.params).value)
            agent.reply(frame, { configOptions: config(native.model) })
          })
        }
      }
    })
    await f.reply('honor saved model', 'existing_lb/gpt-6.1-sol:low')
    await f.host.close(SESSION, 'user-close')
  }
)

it('flushes fresh early updates before the response and keeps the later descriptor', async () => {
  const f = await openModel({
    restored: false,
    script: (agent, native) => {
      agent.on('session/new', (frame) =>
        chunk(agent, [
          push(config(OTHER, 'early-model')),
          response(frame, config(MODEL, 'response-model')),
          push(config(OTHER, 'latest-model'))
        ])
      )
      native.model = OTHER
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = SetSessionConfigOptionRequestSchema.parse(frame.params)
        if (configId !== 'latest-model') {
          agent.fail(frame, -32602, 'Invalid params', 'obsolete model descriptor')
          return
        }
        native.model = String(value)
        agent.reply(frame, { configOptions: config(native.model, 'latest-model') })
      })
    }
  })
  await f.reply('explicit model on new chat', 'existing_lb/gpt-6.1-sol:low')
  await f.host.close(SESSION, 'user-close')
})

it.each(['response-push', 'push-response'] as const)(
  'orders permission %s without replaying the load snapshot',
  async (order) => {
    const f = await openModel({
      permission: true,
      script: (agent, native) => {
        agent.on('session/set_config_option', (frame) => {
          const { configId, value } = SetSessionConfigOptionRequestSchema.parse(frame.params)
          if (configId === 'mode') {
            native.model = order === 'response-push' ? OTHER : MODEL
            const records = [response(frame, config()), push(config(OTHER))]
            chunk(agent, order === 'response-push' ? records : records.toReversed())
          } else {
            if (native.model === MODEL) {
              agent.fail(frame, -32602, 'Invalid params', 'redundant model control refused')
              return
            }
            native.model = String(value)
            agent.reply(frame, { configOptions: config(native.model) })
          }
        })
      }
    })
    await f.reply('after permission setup', 'existing_lb/gpt-6.1-sol:low')
    await f.host.close(SESSION, 'user-close')
  }
)

it('does not adopt another session model update into the selected restored chat', async () => {
  const f = await openModel()
  f.rig.child().agent.notify('session/update', push(config(OTHER), 'old-session').params)
  await f.reply('same saved chat', 'existing_lb/gpt-6.1-sol:low')
  await f.host.close(SESSION, 'user-close')
})

it('reconciles live native drift before sending with the saved choice', async () => {
  const f = await openModel({
    script: (agent, native) => {
      agent.on('session/set_config_option', (frame) => {
        native.model = String(SetSessionConfigOptionRequestSchema.parse(frame.params).value)
        agent.reply(frame, { configOptions: config(native.model) })
      })
    }
  })
  await f.reply('before drift', 'existing_lb/gpt-6.1-sol:low')
  f.native.model = OTHER
  f.rig.child().agent.notify('session/update', push(config(OTHER)).params)
  await f.reply('after drift', 'existing_lb/gpt-6.1-sol:low')
  await f.host.close(SESSION, 'user-close')
})
