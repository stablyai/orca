import { expect, it, onTestFinished, vi } from 'vitest'
import recorded from '../../acp/fixtures/opencode-v2.0.21-model-efforts.json'
import { AcpStructuredOptions } from '../../acp/acp-structured-options'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { NewSessionResponseSchema } from '../../acp/generated/acp-protocol.generated'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore, type AgentModelCatalogProbe } from './agent-model-catalog-store'

const A = 'opencode/crouton-alpha-free'
const B = 'opencode/beam-free'
const C = 'google/gemini-3.8-flash'
const home = { kind: 'opencode', locator: { kind: 'unmanaged' } } as const
function menu(key: 'new' | typeof B | typeof C) {
  const options = new AcpStructuredOptions(acpLaunchSpecFor('opencode2')!.dialect)
  options.adoptSession(NewSessionResponseSchema.parse({ sessionId: 'probe', ...recorded[key] }))
  return options.read().models
}

function setup(probe: AgentModelCatalogProbe) {
  let now = 0
  const record = agentSessionRecordFixture({
    sessionId: 'session-a',
    provider: 'opencode2',
    accountHome: home,
    options: { model: A }
  })
  const store = new AgentModelCatalogStore({ now: () => now })
  const service = createAgentModelCatalogService({
    store,
    getRecord: (sessionId) => ({ ...record, sessionId }),
    getConversation: (sessionId) => agentSessionConversationView({ ...record, sessionId }),
    drivesRecord: () => true,
    resolveAccountHome: async () => home,
    recordWorkspacePath: async () => '/workspace',
    agentReadsProjectModelConfig: () => false,
    workspaceMayOverrideDefaultModel: async () => false,
    probes: { opencode2: probe }
  })
  onTestFinished(() => service.stop())
  return {
    service,
    store,
    advance: () => {
      now += 120_001
    }
  }
}

it.each([1, 10])(
  'shares target discovery across %s duplicate demands and drains a joined target before settling',
  async (n) => {
    const gate = Promise.withResolvers<void>()
    const targets: (string | undefined)[] = []
    const probe: AgentModelCatalogProbe = async (_home, options) => {
      const target = options?.selectedModels?.[0]
      targets.push(target)
      if (target === B) {
        await gate.promise
      }
      return { origin: 'probe', models: menu(target === B || target === C ? target : 'new') }
    }
    const { service } = setup(probe)
    const params = { agent: 'opencode2', sessionId: 'session-a' }
    await service.read({ ...params, waitForListing: true })
    const first = service.demand({ ...params, selectedModel: B })
    await vi.waitFor(() => expect(targets).toEqual([A, B]))
    const joined = Array.from({ length: n }, (_, i) =>
      service.demand({ ...params, sessionId: i % 2 ? 'session-b' : 'session-a', selectedModel: C })
    )
    await vi.waitFor(() => expect(service.snapshot(params).listingInProgress).toBe(true))
    const waited = service.read({ ...params, selectedModel: C, waitForListing: true })
    gate.resolve()
    await Promise.all([first, ...joined])
    const result = await waited
    expect(targets).toEqual([A, B, C])
    expect(result.origin).not.toBe('unknown')
    if (result.origin === 'unknown') {
      throw new Error('expected discovered catalog')
    }
    expect(
      [A, B, C].map((id) => result.models.find((row) => row.id === id)?.efforts.length)
    ).toEqual([7, 6, 4])
    expect(result.listingInProgress).not.toBe(true)
    await service.demand({ ...params, selectedModel: B })
    expect(targets).toHaveLength(3)
  }
)

it('backs off a successful partial target, keeps saved-only reads passive, and retries after expiry', async () => {
  const probe = vi.fn<AgentModelCatalogProbe>(async () => ({
    origin: 'probe',
    models: menu('new')
  }))
  const { service, advance } = setup(probe)
  const params = { agent: 'opencode2', sessionId: 'session-a', selectedModel: B }
  await service.read({ ...params, savedOnly: true })
  expect(probe).not.toHaveBeenCalled()
  await service.read({ ...params, waitForListing: true })
  await Promise.all(Array.from({ length: 10 }, () => service.demand(params)))
  expect(probe).toHaveBeenCalledTimes(1)
  advance()
  await service.read({ ...params, waitForListing: true })
  expect(probe).toHaveBeenCalledTimes(2)
})

it.each([
  { n: 1, partial: false },
  { n: 10, partial: false },
  { n: 2, partial: true }
])(
  'batches $n distinct waiting models into one startup (partial=$partial)',
  async ({ n, partial }) => {
    const gate = Promise.withResolvers<void>()
    const ids = Array.from({ length: n }, (_, i) => `${C}-${i}`)
    const rows = [
      ...menu('new').filter((row) => row.id !== C),
      ...ids.map((id) => ({
        id,
        label: id,
        isDefault: false,
        effortsKnown: false as const,
        efforts: []
      }))
    ]
    const efforts = menu(B).find((row) => row.id === B)!.efforts
    const batches: string[][] = []
    const probe: AgentModelCatalogProbe = async (_home, options) => {
      const targets = [...(options?.selectedModels ?? [])]
      batches.push(targets)
      if (targets.includes(B)) {
        await gate.promise
      }
      const attempted = partial && targets.length > 1 ? targets.slice(0, 1) : targets
      return {
        origin: 'probe',
        attemptedModels: attempted,
        models: rows.map((row) => {
          if (!attempted.includes(row.id)) {
            return row
          }
          const { effortsKnown: _unknown, ...known } = row
          return { ...known, efforts }
        })
      }
    }
    const { service } = setup(probe)
    const params = { agent: 'opencode2', sessionId: 'session-a' }
    await service.read({ ...params, waitForListing: true })
    const first = service.demand({ ...params, selectedModel: B })
    await vi.waitFor(() => expect(batches).toEqual([[A], [B]]))
    const waiting = ids.map((selectedModel, i) => ({
      ...params,
      sessionId: `waiting-${i}`,
      selectedModel
    }))
    const demands = waiting.map((request) => service.demand(request))
    await vi.waitFor(() => {
      for (const request of waiting) {
        expect(service.snapshot(request).listingInProgress).toBe(true)
      }
    })
    gate.resolve()
    await Promise.all([first, ...demands])
    expect(batches).toEqual(partial ? [[A], [B], ids, ids.slice(1)] : [[A], [B], ids])
    const result = service.snapshot(params)
    expect(result.origin).not.toBe('unknown')
    if (result.origin === 'unknown') {
      throw new Error('expected discovered catalog')
    }
    expect(result.models.filter((row) => ids.includes(row.id)).map((row) => row.efforts)).toEqual(
      ids.map(() => efforts)
    )
  }
)
