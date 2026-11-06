import { hostTestCatalogReadOperation } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionModelOption } from '../../../../shared/agent-session/agent-session-wire'
import { readStructuredAgentSessionOptions } from '../../../native-chat/agent-session-wire/structured-agent-session-options-read'
import { claudeAndCodexAgents } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionMutationContext } from '../../../native-chat/agent-session-wire/structured-agent-session-host-mutations'

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
        inputOrder: { hasInputs: () => false },
        statusRead: () => ({ items: [], submissions: [] }),
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
