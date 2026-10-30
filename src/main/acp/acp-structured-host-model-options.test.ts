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
import { framesOf, launch, openHostRig, send, stop } from './acp-structured-host.test-support'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import {
  CALLER,
  envelope,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { withLiveCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { AcpStructuredOptions } from './acp-structured-options'
import { readStructuredAgentSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-options-read'
import { structuredAgentSessionHandingOver } from '../native-chat/agent-session-wire/structured-agent-session-handing-over'

const recording = JSON.parse(
  readFileSync(new URL('./fixtures/antigravity-v1.4.3-options.json', import.meta.url), 'utf8')
)
const session = NewSessionResponseSchema.parse({
  ...recording.session,
  sessionId: PROVIDER_SESSION
})
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
  const spec = settings.flat ? { ...SPEC, permissionModeConfig: undefined } : SPEC
  const rig = await openHostRig({
    spec,
    modelCatalog: catalog,
    initialize: recording.initialize,
    deps: {
      resolveLaunch: async () => ({
        ...(await launch(() => resumed, spec)()),
        env: { GEMINI_HOME: accountHome.path }
      }),
      optionWriteTimeoutMs: settings.timeoutMs
    },
    script: (agent) => {
      let native = settings.flat ? [] : (session.configOptions ?? [])
      if (settings.noEffort) {
        native = native.filter((row) => row.category !== 'thought_level')
      }
      for (const method of ['session/new', 'session/load', 'session/resume']) {
        agent.on(method, (frame) => {
          if (method === 'session/resume') {
            expect(ResumeSessionRequestSchema.parse(frame.params).sessionId).toBe(PROVIDER_SESSION)
          }
          const configOptions = method === 'session/load' || !settings.flat ? native : undefined
          agent.reply(frame, { ...session, configOptions })
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
                ? (session.configOptions ?? [])
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

it.each([
  ['live', 10],
  ['live', 100],
  ['cold', 1],
  ['restart', 1],
  ['busy', 1],
  ['held', 1]
] as const)(
  'retains Low through first Pro dispatch with bounded idle work (%s, history=%i)',
  async (path, count) => {
    const rig = await openModels()
    expect(await rig.picks('effort', 'low')).toMatchObject({ ok: true })
    await rig.deliver('apply Low')
    for (let i = 1; i < count; i++) {
      await rig.deliver(`history ${i}`)
    }
    const saved = await rig.catalog.read({
      agent: 'antigravity',
      sessionId: SESSION,
      savedOnly: true
    })
    if (saved.origin === 'unknown') {
      throw new Error('catalog missing')
    }
    expect(saved.models.find((row) => row.id === PRO)).toMatchObject({
      efforts: [],
      effortsKnown: false
    })
    const scans = vi.spyOn(rig.journal(), 'submissions')
    if (path === 'cold') {
      await rig.host.close(SESSION, 'user-close')
    }
    const wake = await rig.defer(path)
    const proWrites = rig.writes().length
    expect(await rig.picks('model', PRO)).toMatchObject({ ok: true })
    if (path === 'live') {
      await rig.host.readOptions(SESSION)
      const examined = scans.mock.results.reduce(
        (total, result) => total + (result.type === 'return' ? result.value.length : 0),
        0
      )
      expect(examined).toBeLessThanOrEqual(100 * count)
      expect(
        rig
          .writes()
          .slice(proWrites)
          .filter(
            ({ params }) => SetSessionConfigOptionRequestSchema.parse(params).configId === 'model'
          )
      ).toHaveLength(1)
    }
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: PRO, effort: 'low' })
    await wake()
    if (path === 'restart') {
      await rig.host.close(SESSION, 'user-close')
      expect(await rig.attach(rig.fence())).toMatchObject({ ok: true })
      await rig.ready()
    }
    const id = await rig.deliver('Pro without re-picking effort')
    expect(rig.journal().submission(id)?.options).toMatchObject({ model: PRO, effort: 'low' })
    expect(
      rig
        .writes()
        .slice(path === 'cold' || path === 'restart' ? 0 : proWrites)
        .at(-1)?.params
    ).toMatchObject({
      configId: 'thinking_level',
      value: 'low'
    })
  }
)

it.each([false, 'normal', 'live', 'busy', 'held'] as const)(
  'attempts retained Medium after %s Pro selection and accepts an explicit Low correction',
  async (path) => {
    const rig = await openModels({ saved: { model: FLASH, effort: 'medium' } })
    expect(await rig.picks('model', FLASH)).toMatchObject({ ok: true })
    await rig.host.readOptions(SESSION)
    await rig.deliver('Flash Medium')
    const wake = await rig.defer(path)
    if (path === 'normal') {
      const target = new AcpStructuredOptions()
      target.adoptSession({ ...session, ...response('pro') })
      rig.catalog.recordLiveListing(SESSION, withLiveCatalogListing(target.read()).catalogListing)
    } else if (path) {
      rig.rig.child().agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        update: { sessionUpdate: 'config_option_update', ...response('pro') }
      })
      await rig.rig.settle()
      await rig.host.readOptions(SESSION)
      expect(
        rig.rig.adapter['children'].sessions.get(SESSION)?.options.appliedInput.get('effort')
      ).toBe('medium')
    }
    expect(await rig.picks('model', PRO)).toMatchObject({ ok: true })
    await rig.host.readOptions(SESSION)
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: PRO, effort: 'medium' })
    const before = framesOf(rig.rig.child(), 'session/prompt').length
    const id = await send(rig.host, 'retained Medium')
    if (path === 'busy' || path === 'held') {
      expect(rig.journal().submission(id)?.options).toEqual({ model: PRO, effort: 'medium' })
      await rig.rig.settle()
      expect(framesOf(rig.rig.child(), 'session/prompt')).toHaveLength(before)
    }
    await wake()
    await waitFor(() =>
      expect(rig.journal().submission(id)).toMatchObject({
        options: { model: PRO, effort: 'medium' },
        dispatchState: 'rejected',
        rejection: { kind: 'providerRejected' }
      })
    )
    await waitFor(() =>
      expect(structuredAgentSessionHandingOver(rig.journal()).has(id)).toBe(false)
    )
    expect(rig.writes().at(-1)?.params).toMatchObject({
      configId: 'thinking_level',
      value: 'medium'
    })
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: PRO, effort: 'medium' })
    expect(framesOf(rig.rig.child(), 'session/prompt')).toHaveLength(
      before + (path === 'held' ? 1 : 0)
    )
    expect(
      framesOf(rig.rig.child(), 'session/prompt').some(({ params }) =>
        JSON.stringify(params).includes('retained Medium')
      )
    ).toBe(false)
    expect(await rig.picks('effort', 'low')).toMatchObject({ ok: true })
    const corrected = await rig.deliver('supported Low')
    expect(rig.journal().submission(corrected)?.options).toEqual({ model: PRO, effort: 'low' })
    expect(rig.writes().at(-1)?.params).toMatchObject({ configId: 'thinking_level', value: 'low' })
  }
)

it.each([false, true])(
  'retains the same rejected model pick through actual Send (idle control=%s)',
  async (idle) => {
    const options = { model: 'opaque/rejected-model', effort: 'low' }
    const request = { sessionId: PROVIDER_SESSION, configId: 'model', value: options.model }
    const rig = await openModels({
      saved: { model: FLASH, effort: options.effort },
      control: (agent, frame) => {
        agent.fail(frame, -32602, 'Model unavailable')
        return true
      }
    })
    if (!idle) {
      vi.spyOn(rig.rig.adapter, 'canSetOptionWhileIdle').mockReturnValue(false)
    }
    expect(await rig.picks('model', options.model)).toMatchObject({ ok: true, value: { options } })
    await rig.host.readOptions(SESSION)
    expect(rig.writes()).toHaveLength(idle ? 1 : 0)
    await waitFor(() =>
      expect(rig.ownership()).toEqual({ tasks: 0, handles: 0, places: 0, lanes: 0 })
    )
    expect(rig.store.getRecord(SESSION)?.options).toEqual(options)
    const id = await send(rig.host, 'same rejected selection')
    await waitFor(() =>
      expect(rig.journal().submission(id)).toMatchObject({
        options,
        dispatchState: 'rejected',
        rejection: { kind: 'providerRejected' }
      })
    )
    await waitFor(() =>
      expect(structuredAgentSessionHandingOver(rig.journal()).has(id)).toBe(false)
    )
    expect(
      rig.writes().map(({ params }) => SetSessionConfigOptionRequestSchema.parse(params))
    ).toEqual(Array.from({ length: idle ? 2 : 1 }, () => request))
    expect(rig.store.getRecord(SESSION)?.options).toEqual(options)
    expect(framesOf(rig.rig.child(), 'session/prompt')).toHaveLength(0)
  }
)

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

it.each(['Stop', 'deadline', 'child close', 'unproven close'] as const)(
  'retires an uncertain producer on %s without sending on its old channel',
  async (ending) => {
    let holding = false
    const rig = await openModels({
      timeoutMs: 100,
      control: (_agent, frame) =>
        holding && SetSessionConfigOptionRequestSchema.parse(frame.params).configId === 'model'
    })
    await rig.deliver('history before uncertainty')
    const priorWrites = rig.writes().length
    holding = true
    if (ending === 'deadline' || ending === 'unproven close') {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    }
    await rig.picks('model', PRO)
    await waitFor(() => expect(rig.writes()).toHaveLength(priorWrites + 1))
    const child = rig.rig.child()
    const native = rig.rig.adapter['children'].sessions.get(SESSION)!
    if (ending === 'unproven close') {
      child.proveClose = async () => false
    }
    const handles = rig.store.getRecord(SESSION)?.providerHandleChain.map(({ handle }) => handle)
    expect(handles?.length).toBeGreaterThan(0)
    const pending = rig.writes()[priorWrites]!
    await rig.picks('model', FLASH)
    await rig.picks('model', PRO)
    const reading = rig.host.readOptions(SESSION).then(
      (answer) => ({ answer }),
      (error: unknown) => ({ error })
    )
    const id = await send(rig.host, 'accepted while outstanding')
    if (ending === 'Stop') {
      await stop(rig.host)
    } else if (ending === 'deadline' || ending === 'unproven close') {
      await vi.advanceTimersByTimeAsync(100)
    } else {
      child.exit()
    }
    vi.useRealTimers()
    await waitFor(() => expect(child.exited).toBe(ending !== 'unproven close'))
    const readResult = await reading
    if (ending === 'unproven close') {
      expect(readResult).toMatchObject({
        error: { message: expect.stringContaining('no live antigravity child') }
      })
    }
    await rig.rig.settle()
    expect(framesOf(child, 'session/prompt')).toHaveLength(1)
    expect(await rig.messages()).toContain('history before uncertainty')
    expect(rig.store.getRecord(SESSION)?.options?.model).toBe(PRO)
    expect(rig.store.getRecord(SESSION)?.providerHandleChain.map(({ handle }) => handle)).toEqual(
      handles
    )
    await waitFor(() => expect(rig.journal().submission(id)?.dispatchState).toBe('rejected'))
    expect(rig.rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
    if (ending === 'child close') {
      expect(await rig.attach(rig.fence())).toMatchObject({ ok: true })
      await rig.ready()
      await rig.picks('model', FLASH)
      await waitFor(() => expect(rig.writes()).toHaveLength(1))
      const completion = rig.state.deliveryOrder.optionsReady(SESSION)
      const latest = rig.host.readOptions(SESSION)
      child.agent.reply(pending, response('pro'))
      await rig.rig.settle()
      expect(rig.state.deliveryOrder.optionsReady(SESSION)).toBe(completion)
      expect(rig.ownership()).toEqual({ tasks: 1, handles: 1, places: 1, lanes: 1 })
      rig.rig.child().agent.reply(rig.writes()[0]!, { configOptions: session.configOptions })
      expect((await latest).current.model).toBe(FLASH)
      await rig.deliver('resumed history')
    } else {
      child.agent.reply(pending, response('pro'))
    }
    await waitFor(() =>
      expect(rig.ownership()).toEqual({ tasks: 0, handles: 0, places: 0, lanes: 0 })
    )
    if (ending === 'unproven close') {
      expect(rig.rig.adapter['children'].sessions.get(SESSION)).toBe(native)
      expect(native.journalClosed).not.toBeNull()
      child.exit()
    }
    await expect(rig.host.close(SESSION, 'user-close')).resolves.toBeUndefined()
  }
)

it.each([
  {
    flat: false,
    model: 'gemini-3.8-flash-medium',
    shown: 'gemini-3.8-flash-medium',
    noEffort: false
  },
  {
    flat: true,
    model: 'gemini-3.8-flash-medium',
    shown: 'gemini-3.8-flash-medium',
    noEffort: false
  },
  { flat: false, model: PRO, shown: PRO, noEffort: true }
])(
  'reads the target before prompt and delivers exact $model (flat=$flat, noEffort=$noEffort)',
  async ({ flat, model, shown, noEffort }) => {
    const rig = await openModels({ flat, noEffort })
    await rig.picks('model', model)
    const answer = await rig.host.readOptions(SESSION)
    expect(answer.current.model).toBe(shown)
    expect(framesOf(rig.rig.child(), 'session/prompt')).toHaveLength(0)
    if (noEffort) {
      expect(answer.models.find((row) => row.id === PRO)?.efforts.map((row) => row.value)).toEqual([
        'low',
        'high'
      ])
    }
    await rig.deliver('saved identity')
    expect(rig.store.getRecord(SESSION)?.options?.model).toBe(model)
    expect(
      framesOf(rig.rig.child(), flat ? 'session/set_model' : 'session/set_config_option').some(
        ({ params }) =>
          flat
            ? JSON.stringify(params).includes(model)
            : SetSessionConfigOptionRequestSchema.parse(params).value === model
      )
    ).toBe(true)
    if (!flat && model === 'gemini-3.8-flash-medium') {
      const before = rig
        .writes()
        .filter(
          ({ params }) => SetSessionConfigOptionRequestSchema.parse(params).configId === 'model'
        ).length
      for (const configOptions of [
        response('pro').configOptions,
        [],
        response('legacy').configOptions
      ]) {
        rig.rig.child().agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'config_option_update', configOptions }
        })
        await rig.rig.settle()
        await rig.deliver('same successful raw input after observation')
      }
      expect(
        rig
          .writes()
          .filter(
            ({ params }) => SetSessionConfigOptionRequestSchema.parse(params).configId === 'model'
          )
      ).toHaveLength(before)
    }
  }
)

it.each(['new cycle', 'replacement', 'rest'] as const)(
  'joins once then reads current state after %s without native read work',
  async (transition) => {
    const rig = await openModels({ control: () => true })
    await rig.picks('model', PRO)
    await waitFor(() => expect(rig.writes()).toHaveLength(1))
    const old = rig.rig.child()
    const base = rig.host['mutationContext']()
    const entered = Promise.withResolvers<void>()
    const continueRead = Promise.withResolvers<void>()
    let entries = 0
    let inLane = false
    const readOptions = rig.rig.adapter.readOptions.bind(rig.rig.adapter)
    const observed = vi.spyOn(rig.rig.adapter, 'readOptions').mockImplementation((input) => {
      expect(inLane).toBe(true)
      return readOptions(input)
    })
    const reading = readStructuredAgentSessionOptions(
      {
        ...base,
        serialize: async <T>(id: string, task: () => Promise<T>): Promise<T> => {
          if (++entries === 2) {
            entered.resolve()
            await continueRead.promise
          }
          return base.serialize(id, async () => {
            inLane = true
            try {
              return await task()
            } finally {
              inLane = false
            }
          })
        }
      },
      SESSION,
      { readsWithoutModel: true }
    )
    await rig.rig.settle()
    expect(observed).not.toHaveBeenCalled()
    old.agent.reply(rig.writes()[0]!, response('pro'))
    await entered.promise
    if (transition === 'new cycle') {
      await rig.picks('model', FLASH)
      await waitFor(() => expect(rig.writes()).toHaveLength(2))
    } else {
      await rig.host.close(SESSION, 'user-close')
      if (transition === 'replacement') {
        expect(await rig.attach(rig.fence())).toMatchObject({ ok: true })
        await rig.ready()
        expect(rig.rig.child()).not.toBe(old)
      }
    }
    const child = rig.host.collaboratorsForTests().sessions.get(SESSION)?.child
    const frames = rig.rig.child().agent.frames.length
    continueRead.resolve()
    const answer = await reading
    expect(entries).toBe(2)
    expect(rig.rig.child().agent.frames).toHaveLength(frames)
    if (transition === 'rest') {
      expect(observed).not.toHaveBeenCalled()
    } else {
      expect(observed).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, fence: child!.fence })
      expect(
        answer.models.find((row) => row.id === (transition === 'new cycle' ? FLASH : PRO))
      ).toMatchObject({ efforts: [], effortsKnown: false })
    }
    if (transition === 'new cycle') {
      expect(rig.state.deliveryOrder.optionsReady(SESSION)).toBeDefined()
      rig.rig.child().agent.reply(rig.writes()[1]!, { configOptions: session.configOptions })
    }
    await waitFor(() =>
      expect(rig.ownership()).toEqual({ tasks: 0, handles: 0, places: 0, lanes: 0 })
    )
  }
)
