import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  NewSessionResponseSchema,
  ResumeSessionRequestSchema,
  SessionConfigValueIdSchema,
  SetSessionConfigOptionRequestSchema,
  SetSessionConfigOptionResponseSchema
} from './generated/acp-protocol.generated'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { framesOf, launch, openHostRig, send } from './acp-structured-host.test-support'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import {
  CALLER,
  envelope,
  hostTestState
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store'
import { structuredAgentSessionHandingOver } from '../native-chat/agent-session-wire/delivery/structured-agent-session-handing-over'

const recorded = (version: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/antigravity-v${version}-options.json`, import.meta.url),
      'utf8'
    )
  )
const sessionOf = (fixture: { session: object }) =>
  NewSessionResponseSchema.parse({ ...fixture.session, sessionId: PROVIDER_SESSION })
const recording = recorded('1.4.3')
const response = (key: string) => SetSessionConfigOptionResponseSchema.parse(recording[key])
const SPEC = acpLaunchSpecFor('antigravity')!
const FLASH = 'gemini-3.8-flash'
const PRO = 'gemini-3.1-pro'
afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

async function openModels(
  settings: {
    saved?: Record<string, string>
    flat?: boolean
    noEffort?: boolean
    timeoutMs?: number
    recording?: typeof recording
    control?: (agent: AcpScriptedAgent, frame: FakeFrame) => boolean
  } = {}
) {
  const accountHome = { variable: 'GEMINI_HOME', path: join(hostTestState().root, 'antigravity') }
  let records: AgentSessionRecordStore | undefined
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: (id) => records?.getRecord(id) ?? undefined,
    getConversation: (id) => records?.getConversation(id) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => accountHome,
    recordWorkspacePath: async () => '/workspace/project',
    agentReadsProjectModelConfig: () => false,
    workspaceMayOverrideDefaultModel: async () => false
  })
  onTestFinished(() => catalog.stop())
  let resumed = false
  const fixture = settings.recording ?? recording
  const opened = sessionOf(fixture)
  const spec = settings.flat ? { ...SPEC, permissionModeConfig: undefined } : SPEC
  const rig = await openHostRig({
    spec,
    modelCatalog: catalog,
    initialize: fixture.initialize,
    deps: {
      resolveLaunch: async () => ({
        ...(await launch(() => resumed, spec)()),
        env: { GEMINI_HOME: accountHome.path }
      }),
      optionWriteTimeoutMs: settings.timeoutMs
    },
    script: (agent) => {
      let native = settings.flat ? [] : (opened.configOptions ?? [])
      if (settings.noEffort) {
        native = native.filter((row) => row.category !== 'thought_level')
      }
      for (const method of ['session/new', 'session/load', 'session/resume']) {
        agent.on(method, (frame) => {
          if (method === 'session/resume') {
            expect(ResumeSessionRequestSchema.parse(frame.params).sessionId).toBe(PROVIDER_SESSION)
          }
          const configOptions = method === 'session/load' || !settings.flat ? native : undefined
          agent.reply(frame, { ...opened, configOptions })
        })
      }
      agent.on('session/set_model', (frame) => agent.reply(frame, {}))
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = SetSessionConfigOptionRequestSchema.parse(frame.params)
        if (configId !== 'mode' && settings.control?.(agent, frame)) {
          return
        }
        if (configId === 'model') {
          native =
            value === PRO
              ? response('pro').configOptions
              : value === FLASH
                ? (opened.configOptions ?? [])
                : response('legacy').configOptions
        } else if (configId === 'thinking_level') {
          const pro = native?.some(
            (row) => row.category === 'model' && row.type === 'select' && row.currentValue === PRO
          )
          if (pro && value === 'medium') {
            agent.fail(frame, -32602, 'Unsupported effort')
            return
          }
          native = native?.map((row) =>
            row.category === 'thought_level' && row.type === 'select'
              ? { ...row, currentValue: SessionConfigValueIdSchema.parse(value) }
              : row
          )
        }
        agent.reply(frame, { configOptions: native })
      })
    }
  })
  records = rig.store
  const attach = (fence: number | null) =>
    rig.host.attach(
      CALLER,
      hostTestAttachParams(fence, {
        provider: 'antigravity',
        agent: 'antigravity',
        accountHome,
        providerHandle: undefined,
        options: fence === null ? (settings.saved ?? { model: FLASH }) : undefined
      })
    )
  expect(await attach(null)).toMatchObject({ ok: true })
  await rig.ready()
  resumed = true
  const journal = () => rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const picks = (key: string, value: string) =>
    rig.host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', { key, value }),
      key,
      value
    })
  const writes = () =>
    framesOf(rig.rig.child(), 'session/set_config_option').filter(
      (frame) => SetSessionConfigOptionRequestSchema.parse(frame.params).configId !== 'mode'
    )
  const state = rig.host.collaboratorsForTests().runtimeState
  const ownership = () => ({
    tasks: rig.host['tasks']['attaching'].size,
    handles: state.acquireAborts['inFlight'].get(SESSION)?.size ?? 0,
    places: state.deliveryOrder['lanes'].get(SESSION)?.places.size ?? 0,
    lanes: state.deliveryOrder['lanes'].size
  })
  const complete = async (id: string) => {
    await waitFor(() =>
      expect(journal().submission(id)?.dispatchState).toMatch(/admitted|accepted/)
    )
    const frame = framesOf(rig.rig.child(), 'session/prompt').at(-1)!
    const turn = journal().runningTurn()?.turnId
    rig.rig.child().agent.reply(frame, { stopReason: 'end_turn' })
    await rig.rig.settle()
    await rig.host.flushStreamedEvents(SESSION)
    await waitFor(() => expect(journal().runningTurn()?.turnId).not.toBe(turn))
    expect(structuredAgentSessionHandingOver(journal()).has(id)).toBe(false)
  }
  const defer = async (path: string | false) => {
    const busy = path === 'busy' ? await send(rig.host, 'busy') : undefined
    if (busy) {
      await waitFor(() =>
        expect(journal().submission(busy)?.dispatchState).toMatch(/admitted|accepted/)
      )
    }
    if (path === 'held') {
      await journal().queuedMessages.insert({
        messageId: 'held',
        holdReason: 'send_failed',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'held' }] }
      })
    }
    return async () => {
      if (busy) {
        await complete(busy)
      }
      if (path === 'held') {
        expect(
          await rig.host.queuedMessageSend(CALLER, {
            envelope: envelope('agentSession.queuedMessageSend', { messageId: 'held' }),
            messageId: 'held'
          })
        ).toMatchObject({ ok: true })
        await complete(journal().submissions().at(-1)!.clientMessageId)
      }
    }
  }
  const deliver = async (text: string) => {
    const id = await send(rig.host, text)
    await complete(id)
    return id
  }
  return {
    ...rig,
    catalog,
    journal,
    picks,
    writes,
    complete,
    deliver,
    attach,
    state,
    ownership,
    defer
  }
}

it.each([10, 100, 'Send', 'rejection'] as const)(
  'coalesces unanswered picks and settles captured FIFO delivery (%s)',
  async (count) => {
    let held: FakeFrame | undefined
    const rig = await openModels({
      saved: { model: FLASH, effort: 'low' },
      control: (_agent, frame) => {
        if (!held) {
          held = frame
          return true
        }
        return false
      }
    })
    const begins = vi.spyOn(rig.state.acquireAborts, 'begin')
    const places = vi.spyOn(rig.state.deliveryOrder, 'reserve')
    let receipted = false
    const receipt = rig.picks('model', PRO).then((result) => {
      receipted = true
      return result
    })
    await waitFor(() => expect(held).toBeDefined())
    await waitFor(() => expect(receipted).toBe(true))
    expect(await receipt).toMatchObject({ ok: true })
    const readingUnderLane = vi.spyOn(rig.rig.adapter, 'readOptions')
    const framesBeforeRead = rig.rig.child().agent.frames.length
    let readDone = false
    const reading = Promise.all([
      rig.host.readOptions(SESSION),
      rig.host.readOptions(SESSION)
    ]).then(([answer, phone]) => {
      for (const result of [answer, phone]) {
        expect(result.current).toMatchObject({ model: FLASH, effort: 'low' })
      }
      readDone = true
      return answer
    })
    await rig.rig.settle()
    expect(readingUnderLane).not.toHaveBeenCalled()
    expect(rig.rig.child().agent.frames).toHaveLength(framesBeforeRead)
    for (let i = 1; i < (typeof count === 'string' ? 4 : count); i++) {
      expect(await rig.picks('model', i % 2 ? FLASH : PRO)).toMatchObject({ ok: true })
      expect(rig.store.getRecord(SESSION)?.options).toEqual({
        model: i % 2 ? FLASH : PRO,
        effort: 'low'
      })
    }
    await rig.rig.settle()
    expect(rig.ownership()).toEqual({ tasks: 1, handles: 1, places: 1, lanes: 1 })
    expect([begins.mock.calls.length, places.mock.calls.length, rig.writes().length]).toEqual([
      1, 1, 1
    ])
    const first = typeof count === 'string' ? await send(rig.host, 'captured Flash') : null
    if (first) {
      await rig.picks('model', PRO)
    }
    const second = first ? await send(rig.host, 'captured Pro') : null
    if (second) {
      await rig.picks('model', FLASH)
    }
    expect(readDone).toBe(false)
    expect(framesOf(rig.rig.child(), 'session/prompt')).toHaveLength(0)
    if (count === 'rejection') {
      rig.rig.child().agent.fail(held!, -32602, 'Optional model rejected')
    } else {
      rig.rig.child().agent.reply(held!, response('pro'))
    }
    const answer = await reading
    if (first && second) {
      for (const [id, model] of [
        [first, FLASH],
        [second, PRO]
      ] as const) {
        expect(rig.journal().submission(id)?.options).toEqual({ model, effort: 'low' })
        await rig.complete(id)
      }
      expect(
        rig.rig
          .child()
          .agent.frames.filter(
            (frame) => rig.writes().includes(frame) || frame.method === 'session/prompt'
          )
          .map(({ method, params }) => ({ method, params }))
      ).toMatchObject([
        { method: 'session/set_config_option', params: { configId: 'model', value: PRO } },
        { method: 'session/set_config_option', params: { configId: 'model', value: FLASH } },
        {
          method: 'session/set_config_option',
          params: { configId: 'thinking_level', value: 'low' }
        },
        {
          method: 'session/prompt',
          params: { prompt: [{ type: 'text', text: 'captured Flash' }] }
        },
        { method: 'session/set_config_option', params: { configId: 'model', value: PRO } },
        {
          method: 'session/set_config_option',
          params: { configId: 'thinking_level', value: 'low' }
        },
        { method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'captured Pro' }] } }
      ])
    } else {
      expect(framesOf(rig.rig.child(), 'session/prompt')).toHaveLength(0)
      expect(answer.current.model).toBe(FLASH)
      expect(
        answer.models.find((row) => row.id === FLASH)?.efforts.map((row) => row.value)
      ).toEqual(['low', 'medium', 'high'])
      expect(
        rig.writes().map(({ params }) => SetSessionConfigOptionRequestSchema.parse(params).value)
      ).toEqual([PRO, FLASH])
    }
    await waitFor(() =>
      expect(rig.ownership()).toEqual({ tasks: 0, handles: 0, places: 0, lanes: 0 })
    )
  }
)
