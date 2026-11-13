import { createStructuredAgentSessionCatalogReads } from '../../native-chat/agent-session-wire/options/structured-agent-session-catalog-reads'
import type { StructuredAgentSessionHostDeps } from '../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type { createAgentModelCatalogSuccessWriter } from '../../native-chat/agent-model-catalog/agent-model-catalog-entry-lifetime'
import { createAcpModelCatalogProbe } from './acp-model-catalog-probe'
import { AgentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { NewSessionResponseSchema } from '../generated/acp-protocol.generated'
import recorded from '../fixtures/opencode-v2-start-options.json'
import { expect, it, vi, onTestFinished } from 'vitest'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  readSessionModels,
  type AcpModelCatalogSessionConnection
} from './acp-listing-session-models'
import type { runAgentModelCatalogListing } from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { runAgentModelCatalogSession } from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

it('publishes inventory before a slow optional effort reply and retains its valid late result', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const late =
    Promise.withResolvers<
      Awaited<ReturnType<AcpModelCatalogSessionConnection['setConfigOption']>>
    >()
  const observations: Awaited<ReturnType<typeof readSessionModels>>[] = []
  const connection: AcpModelCatalogSessionConnection = {
    initialize: async () => ({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { delete: {} } }
    }),
    start: async () => ({
      kind: 'new',
      sessionId: 'listing',
      response: NewSessionResponseSchema.parse(recorded)
    }),
    setConfigOption: () => late.promise,
    deleteSession: async () => ({}),
    close: async () => {}
  }
  const run = runAgentModelCatalogSession(
    () => connection,
    (connection, ready) =>
      readSessionModels(
        acpLaunchSpecFor('opencode2')!,
        { kind: 'session', listingNamesConfiguredModel: false },
        connection,
        '/workspace',
        undefined,
        ['opencode/big-pickle'],
        undefined,
        ready,
        (result) => observations.push(result)
      ),
    { label: 'opencode2', timeoutMs: null }
  )
  await vi.advanceTimersByTimeAsync(45_000)
  expect(observations[0]?.models.find((row) => row.id === 'opencode/big-pickle')).toMatchObject({
    efforts: [],
    effortsKnown: false
  })
  const options = structuredClone(recorded.configOptions)
  options.find((option) => option.id === 'model')!.currentValue = 'opencode/big-pickle'
  late.resolve({
    configOptions: NewSessionResponseSchema.parse({ ...recorded, configOptions: options })
      .configOptions!
  })
  const result = await run
  expect(result.models.find((row) => row.id === 'opencode/big-pickle')?.efforts).toEqual([
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
    { value: 'default', label: 'Default' }
  ])
  expect(result.attemptedModels).toEqual(['opencode/big-pickle'])
  expect(
    observations.at(-1)?.models.find((row) => row.id === 'opencode/big-pickle')?.efforts
  ).toEqual(result.models.find((row) => row.id === 'opencode/big-pickle')?.efforts)
  expect(
    observations[0]?.models.find((row) => row.id === 'opencode/big-pickle')?.effortsKnown
  ).toBe(false)
})

function accumulatedCatalogHarness(count: number) {
  const baseSpec = acpLaunchSpecFor('opencode2')!
  const spec = {
    ...baseSpec,
    managedRuntime: undefined,
    account: {
      ...baseSpec.account,
      environment: (_home: unknown, env: Record<string, string>) => env
    }
  }
  const config = (selected = 'm0') =>
    NewSessionResponseSchema.parse({
      ...recorded,
      configOptions: recorded.configOptions.map((option) =>
        option.id === 'model'
          ? {
              ...option,
              currentValue: selected,
              options: Array.from({ length: count }, (_, index) => ({
                value: `m${index}`,
                name: `Model ${index}`
              }))
            }
          : option
      )
    })
  const requests: {
    model: string
    reply: PromiseWithResolvers<
      Awaited<ReturnType<AcpModelCatalogSessionConnection['setConfigOption']>>
    >
  }[] = []
  const connect = vi.fn((): AcpModelCatalogSessionConnection => ({
    initialize: async () => ({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { delete: {} } }
    }),
    start: async () => ({ kind: 'new', sessionId: 'listing', response: config() }),
    setConfigOption: (_id, model) => {
      const reply =
        Promise.withResolvers<
          Awaited<ReturnType<AcpModelCatalogSessionConnection['setConfigOption']>>
        >()
      requests.push({ model, reply })
      return reply.promise
    },
    deleteSession: async () => ({}),
    close: async () => {}
  }))
  const store = new AgentModelCatalogStore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: measure the production publication boundary required by the scaling regression.
  const writes = vi.spyOn(
    store as unknown as { writeSuccess: ReturnType<typeof createAgentModelCatalogSuccessWriter> },
    'writeSuccess'
  )
  const probe = createAcpModelCatalogProbe(spec, {
    resolveEnvironment: async () => ({}),
    resolveCommand: () => process.execPath,
    probeVersion: async () => ({ version: '2.1.0' }),
    homePath: '/account',
    dataDirectory: '/unused',
    connectSession: connect
  })
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => undefined,
    getConversation: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'HOME', path: '/account' }),
    probes: { opencode2: probe }
  })
  const externalRead = createStructuredAgentSessionCatalogReads(() => ({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionless catalog reads only access modelCatalog; no chat or journal is mocked.
    deps: { modelCatalog: service } as StructuredAgentSessionHostDeps,
    serialize: async (_id, task) => task(),
    scopeOwned: async () => null
  }))
  const read = (waitForListing = true, selectedModel?: string) =>
    externalRead({ agent: 'opencode2', workspacePath: '/workspace', waitForListing, selectedModel })
  onTestFinished(() => service.stop())
  const answer = (index: number) => {
    const request = requests[index]!
    request.reply.resolve({ configOptions: config(request.model).configOptions! })
  }
  return { store, writes, service, requests, connect, read, answer }
}

it.each([10, 100])(
  'accumulates %i untargeted menus without publishing the full catalog per reply',
  async (count) => {
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const h = accumulatedCatalogHarness(count)
    const first = h.read()
    await vi.advanceTimersByTimeAsync(0)
    expect((await first).models).toHaveLength(count)
    let delivered = false
    const observer = h.read().then((answer) => {
      delivered = true
      return answer
    })
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < count - 1; index++) {
      h.answer(index)
      await vi.advanceTimersByTimeAsync(0)
      if (index < count - 2) {
        expect(delivered).toBe(false)
      }
    }
    const final = await observer
    expect(final.models?.every((model) => model.effortsKnown !== false)).toBe(true)
    expect(h.connect).toHaveBeenCalledOnce()
    // One initial inventory and one terminal observation, independent of the target count.
    expect(h.writes.mock.calls.length).toBeLessThanOrEqual(2)
    expect(
      h.writes.mock.calls.reduce((rows, call) => rows + call[2].models.length, 0)
    ).toBeLessThanOrEqual(count * 2)
  }
)

it.each(['snapshot', 'deadline', 'selected'])(
  'exposes accumulated menus at a %s boundary while the next switch is unanswered',
  async (boundary) => {
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const h = accumulatedCatalogHarness(5)
    const first = h.read()
    await first
    const observer = h.read()
    h.answer(0)
    await vi.advanceTimersByTimeAsync(6_000)
    // m1 has answered; m2 is still pending, beyond the old optional sweep cutoff.
    if (boundary === 'snapshot') {
      expect((await h.read(false)).models?.find((row) => row.id === 'm1')?.effortsKnown).toBe(true)
    } else if (boundary === 'selected') {
      expect((await h.read(true, 'm1')).models?.find((row) => row.id === 'm1')?.effortsKnown).toBe(
        true
      )
    } else {
      await vi.advanceTimersByTimeAsync(24_000)
    }
    expect((await observer).models?.find((row) => row.id === 'm1')?.effortsKnown).toBe(true)
    let followed = false
    const follow = h.read().then((answer) => {
      followed = true
      return answer
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(followed).toBe(false)
    // New selected demand joins the same owner and is promoted after its outstanding switch.
    const selected = h.read(true, 'm4')
    h.answer(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.requests[2]?.model).toBe('m4')
    h.answer(2)
    await vi.advanceTimersByTimeAsync(0)
    expect((await selected).models?.find((row) => row.id === 'm4')?.effortsKnown).toBe(true)
    await follow
    h.answer(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.connect).toHaveBeenCalledOnce()
  }
)

it('keeps a slow OpenCode 1.x version response and selects its command listing', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const version = Promise.withResolvers<{ version: string }>()
  const requested = Promise.withResolvers<void>()
  const base = acpLaunchSpecFor('opencode')!
  const session = vi.fn()
  const command = vi.fn<typeof runAgentModelCatalogListing>(
    async () => 'opencode/slow-valid-model\n'
  )
  const probe = createAcpModelCatalogProbe(
    { ...base, account: { ...base.account, environment: (_home, env) => env } },
    {
      resolveEnvironment: async () => ({}),
      resolveCommand: () => process.execPath,
      probeVersion: async () => {
        requested.resolve()
        return version.promise
      },
      dataDirectory: '/unused',
      homePath: '/account',
      runListing: command,
      connectSession: session
    }
  )
  const result = probe({ variable: 'HOME', path: '/account' }, { workspacePath: '/workspace' })
  await requested.promise
  await vi.advanceTimersByTimeAsync(45_000)
  version.resolve({ version: '1.18.31' })
  expect((await result).models.map((row) => row.id)).toEqual(['opencode/slow-valid-model'])
  expect(session).not.toHaveBeenCalled()
  expect(command.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: null })
})
