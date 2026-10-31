import { hostTestCatalogReadOperation } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import type { AgentSessionModelOption } from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { readStructuredAgentSessionOptions } from '../../../native-chat/agent-session-wire/structured-agent-session-options-read'
import { claudeAndCodexAgents } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionMutationContext } from '../../../native-chat/agent-session-wire/structured-agent-session-host-mutations'
import type { RpcContext } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from './structured-agent-session-options-read'

vi.mock('./structured-agent-session-gate', () => ({
  requireInstalledStructuredHost: vi.fn(),
  requireStructuredAgentAudience: vi.fn(),
  requireStructuredHost: vi.fn()
}))
afterEach(() => vi.restoreAllMocks())

it.each([100, 1_000])(
  'projects %i unknown fallback models once per options read',
  async (models) => {
    let copies = 0
    const rows: AgentSessionModelOption[] = Array.from({ length: models }, (_, index) => ({
      id: `model-${index}`,
      get label() {
        copies += 1
        return `Model ${index}`
      },
      isDefault: index === 0,
      efforts: []
    }))
    const agents = claudeAndCodexAgents()
    const definition = agents.definition('claude')!
    const fallbackModels = vi.fn(() => rows)
    vi.spyOn(agents, 'definition').mockReturnValue({
      ...definition,
      restingOptions: { ...definition.restingOptions!, fallbackModels }
    })
    const record = { ...agentSessionRecordFixture(), providerHandleChain: [] }
    const conversation = {
      child: null,
      params: { provider: 'claude' },
      journal: {
        threadGoal: () => null,
        submissions: () => [],
        visitItems: () => {},
        wroteBeforeOpen: () => false,
        contextUsage: () => null,
        context: { floor: () => null }
      }
    }
    const catalogRead = vi.fn(async () => ({ origin: 'unknown' as const }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read uses only these supplied context and journal members; no provider can start.
    const context = {
      deps: {
        agents,
        adapter: {},
        store: {
          getRecord: () => record,
          getConversation: () => agentSessionConversationView(record)
        },
        modelCatalog: { read: catalogRead, captureRead: hostTestCatalogReadOperation }
      },
      serialize: (_session: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => conversation,
      conversation: async () => conversation
    } as unknown as StructuredAgentSessionMutationContext
    const started = performance.now()
    const answer = await readStructuredAgentSessionOptions(context, record.sessionId, {
      readsWithoutModel: true
    })
    const elapsedMs = performance.now() - started
    expect(copies).toBe(models) // Getter observes actual spread copies in the production fallback map.
    expect(fallbackModels).toHaveBeenCalledTimes(1)
    expect(catalogRead).toHaveBeenCalledTimes(2) // Scoped inventory and proof; atRest is reused.
    expect(answer.models).toHaveLength(models)
    expect(answer.models.every((row) => !row.isDefault)).toBe(true)
    expect(answer.current.model).toBeUndefined()
    expect(rows[0].isDefault).toBe(true)
    console.info('unknown-options-perf', {
      models,
      copies,
      catalogReads: catalogRead.mock.calls.length,
      elapsedMs
    })
  }
)

it.each([100, 1_000])(
  'filters %i rows only for a model-less incapable RPC reader',
  async (models) => {
    let visits = 0
    const rows: AgentSessionModelOption[] = Array.from({ length: models }, (_, index) => ({
      get id() {
        visits += 1
        return `model-${index}`
      },
      label: `Model ${index}`,
      isDefault: false,
      efforts: []
    }))
    const readOptions = vi.fn(async () => ({
      models: rows,
      current: {},
      rewind: { supported: false as const, reason: 'unsupported' as const }
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real RPC handler calls only readOptions on the already-installed host returned by this gate double.
    vi.mocked(requireInstalledStructuredHost).mockResolvedValue({
      readOptions
    } as unknown as Awaited<ReturnType<typeof requireInstalledStructuredHost>>)
    const method = STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS.find(
      (entry) => entry.name === 'agentSession.options'
    )!
    for (const capable of [false, true]) {
      visits = 0
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler reads only client kind/capabilities; host installation is the seam above.
      const context = {
        clientKind: 'mobile',
        clientCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          ...(capable ? [AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY] : [])
        ]
      } as unknown as RpcContext
      const started = performance.now()
      const answer = await method.handler({ sessionId: 'perf-session' }, context)
      const elapsedMs = performance.now() - started
      expect(visits).toBe(capable ? 0 : models)
      expect(answer.models).toHaveLength(models + (capable ? 0 : 1))
      expect(answer.current.model).toBe(capable ? undefined : '')
      if (capable) {
        expect(answer.models).toBe(rows)
      }
      console.info('legacy-options-perf', { models, capable, visits, elapsedMs })
    }
    expect(readOptions).toHaveBeenCalledTimes(2)
  }
)
