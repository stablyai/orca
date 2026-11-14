import type { AntigravityChatAuthConfig } from '../../../shared/antigravity-chat-auth-config'
import { afterEach, expect, it } from 'vitest'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
import { z } from 'zod'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  type AcpAdapterRig,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'
import type { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import { GrokFixtureReplay } from './testing/acp-structured-fixture-replay.test-support'
import {
  readAcpFixture,
  type AcpFixtureFrame
} from '../timeline/testing/acp-timeline-fixture.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
const result = (frame: AcpFixtureFrame | undefined) =>
  z.record(z.string(), z.unknown()).parse(frame?.message.result)
afterEach(closeProviderTimelineRigs)

async function nativeOptionsRig({
  loaded = true,
  configOptions = fixture.session.configOptions,
  modelConfigOptions = configOptions,
  script
}: {
  loaded?: boolean
  configOptions?: typeof fixture.session.configOptions
  modelConfigOptions?: typeof fixture.session.configOptions
  script?: (agent: AcpScriptedAgent) => void
} = {}) {
  return openAcpAdapterRig({
    spec: ANTIGRAVITY,
    initialize: fixture.initialize,
    launch: loaded
      ? {
          resume: {
            sessionId: PROVIDER_SESSION,
            key: 'acp:antigravity:saved',
            mayBeUnsaved: () => false,
            unannouncedLosses: () => []
          }
        }
      : undefined,
    script: (agent) => {
      for (const method of ['session/new', 'session/resume']) {
        agent.on(method, (frame) =>
          agent.reply(frame, { ...fixture.session, sessionId: PROVIDER_SESSION, configOptions })
        )
      }
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = z
          .object({ configId: z.string(), value: z.string() })
          .parse(frame.params)
        agent.reply(frame, {
          configOptions:
            configId === 'thinking_level'
              ? value === 'low'
                ? fixture.low.configOptions
                : fixture.high.configOptions
              : configId === 'model'
                ? modelConfigOptions
                : configOptions
        })
      })
      script?.(agent)
    }
  })
}

it('honors restored native effort while retaining changed, unknown, explicit and new choices', async () => {
  const rigs: AcpAdapterRig[] = []
  const unknown = fixture.session.configOptions.map((option) =>
    option.category === 'thought_level' ? { ...option, currentValue: '' } : option
  )
  for (const scenario of [
    { loaded: true, effort: 'high', writes: [] },
    { loaded: true, effort: 'low', writes: ['low'] },
    { loaded: true, effort: 'high', configOptions: unknown, writes: ['high'] },
    { loaded: false, effort: 'high', writes: ['high'] }
  ]) {
    const rig = await nativeOptionsRig(scenario)
    rigs.push(rig)
    await rig.acquire()
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'restored-choice',
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      executionOptions: { model: 'gemini-3.8-flash', effort: scenario.effort }
    })
    const prompt = await rig.frame('session/prompt')
    expect(
      rig.sent('session/set_config_option').flatMap(({ params }) => {
        const { configId, value } = z
          .object({ configId: z.string(), value: z.string() })
          .parse(params)
        return configId === 'thinking_level' ? [value] : []
      })
    ).toEqual(scenario.writes)
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
  }
  const restored = rigs[0]!
  await restored.adapter.setOption({ sessionId: SESSION, fence: 1, key: 'effort', value: 'high' })
  expect(restored.sent('session/set_config_option').at(-1)?.params).toMatchObject({
    configId: 'thinking_level',
    value: 'high'
  })
})

it('uses effort from a model response and never borrows it across a legacy model control', async () => {
  for (const scenario of [
    { model: 'gemini-3.8-flash-high', native: fixture.high, effortWrites: [], legacy: false },
    { model: 'gemini-3.8-flash-low', native: fixture.low, effortWrites: ['high'], legacy: false },
    { model: 'gemini-3.8-flash-low', native: fixture.high, effortWrites: ['high'], legacy: true }
  ]) {
    const { legacy } = scenario
    const configOptions = fixture.session.configOptions.filter(
      (option) => !legacy || option.category !== 'model'
    )
    const rig = await nativeOptionsRig({
      configOptions,
      modelConfigOptions: scenario.native.configOptions,
      script: (agent) => agent.on('session/set_model', (frame) => agent.reply(frame, {}))
    })
    await rig.acquire()
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'model-choice',
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      executionOptions: { model: scenario.model, effort: 'high' }
    })
    await rig.frame('session/prompt')
    expect(rig.sent('session/set_model').map(({ params }) => params)).toEqual(
      legacy ? [{ sessionId: PROVIDER_SESSION, modelId: 'gemini-3.8-flash-low' }] : []
    )
    expect(
      rig.sent('session/set_config_option').flatMap(({ params }) => {
        const { configId, value } = z
          .object({ configId: z.string(), value: z.string() })
          .parse(params)
        return configId === 'thinking_level' ? [value] : []
      })
    ).toEqual(scenario.effortWrites)
  }
})

it('cancels activation metadata with the open signal after acquisition has ended', async () => {
  const entered = Promise.withResolvers<AbortSignal | undefined>()
  const release = Promise.withResolvers<void>()
  const rig = await openAcpAdapterRig({
    spec: {
      ...ANTIGRAVITY,
      resolveSessionMeta: async ({ signal }) => {
        entered.resolve(signal)
        await release.promise
        signal?.throwIfAborted()
        return undefined
      }
    }
  })
  const acquired = await rig.acquire({ waitForStart: false })
  const controller = new AbortController()
  const opening = rig.adapter
    .open({
      sessionId: SESSION,
      fence: 1,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: controller.signal
    })
    .catch(() => undefined)
  const signal = await entered.promise
  controller.abort()
  release.resolve()
  await opening
  expect(signal?.aborted).toBe(true)
  expect(rig.sent('session/new')).toHaveLength(0)
})

it.each<{ config: AntigravityChatAuthConfig | undefined; method: string }>([
  {
    config: {
      method: 'oauth-business',
      gcpProject: 'enterprise-project',
      gcpLocation: 'us-central1'
    },
    method: 'oauth-business'
  }
])(
  'signs a first chat in with $method, asks in default mode, and answers a question',
  async ({ config, method }) => {
    const [initialized, opened, ...turn] = await readAcpFixture('antigravity-v1-question')
    const replay = new GrokFixtureReplay(turn)
    const rig = await openAcpAdapterRig({
      spec: ANTIGRAVITY,
      launch: { antigravityChatAuth: config },
      initialize: result(initialized),
      script: (agent) => {
        replay.attach(agent)
        // The recorded server requires explicit authentication even with a fresh folder.
        agent.on('session/new', (frame) =>
          agent.frames.some((sent) => sent.method === 'authenticate')
            ? agent.reply(frame, { ...result(opened), sessionId: PROVIDER_SESSION })
            : agent.fail(frame, -32000, 'Authentication required')
        )
        agent.on('authenticate', (frame) => agent.reply(frame, {}))
      }
    })
    await rig.acquire()
    expect(rig.sent('authenticate')[0]?.params).toEqual({ methodId: method })
    expect(rig.sent('session/set_config_option')[0]?.params).toMatchObject({ value: 'default' })
    await sendHello(rig, 'send-1')
    const question = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((row) => row.body.kind === 'question')
      expect(found && replay.awaiting).toBe('reply')
      return found!
    })
    expect(question.body).toMatchObject({ options: [{ label: 'red' }, { id: '2', label: 'blue' }] })
    await rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: question.itemId,
      kind: 'question',
      response: { kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['2'] }] },
      fence: 1,
      commit: async () => {}
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    const reply = rig.child().agent.frames.find((frame) => !frame.method && frame.id === 2)
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: '2' } })
    await waitFor(async () =>
      expect((await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toEqual(
        [expect.objectContaining({ state: 'completed', outcome: 'success' })]
      )
    )
  }
)

it("leaves a Full access host chat's plan approval to the person", async () => {
  let answered = false
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    launch: { args: ['acp', '--dangerously-skip-permissions'], fullAccess: true },
    script: (agent) =>
      agent.on('session/prompt', () => {
        // agy's flag does not approve plans, so it still asks.
        void agent
          .request('plan', 'session/request_permission', {
            sessionId: PROVIDER_SESSION,
            toolCall: { toolCallId: 'plan-1', title: 'Approve plan' },
            options: [{ optionId: 'proceed', name: 'Proceed', kind: 'allow_once' }]
          })
          .then(() => {
            answered = true
          })
      })
  })
  await rig.acquire({ permissionMode: 'full-access' })
  await sendHello(rig, 'send-1')
  await waitFor(async () =>
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(true)
  )
  expect(answered).toBe(false)
})

it('stops a chat that has left the gate but is not loaded yet before the operation runs', async () => {
  const [initialized, opened] = await readAcpFixture('antigravity-v1-question')
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    initialize: result(initialized),
    script: (agent) =>
      agent.on('session/new', (frame) =>
        agent.reply(frame, { ...result(opened), sessionId: PROVIDER_SESSION })
      )
  })
  // Acquisition ended, but no loaded chat owns this child yet.
  await rig.acquire()
  const child = rig.child()
  let ranOverLiveChild: boolean | null = null
  await ANTIGRAVITY.launchGate!.run(
    async () => {},
    async () => {
      ranOverLiveChild = !child.exited
    }
  )
  expect(ranOverLiveChild).toBe(false)
})
