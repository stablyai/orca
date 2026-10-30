import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { it, expect, vi } from 'vitest'
import { createClaudeModelCatalogProbe } from '../../claude/claude-model-catalog-probe'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'

const SESSION = 'session-1'
function restingJournal() {
  return {
    threadGoal: () => null,
    visitItems: () => {},
    submissions: () => [],
    contextUsage: () => null,
    context: { floor: () => null }
  }
}

it('keeps one legacy deadline across an optional join and current resting read', async () => {
  vi.useFakeTimers()
  const args = Promise.withResolvers<string[]>()
  const resolving = vi.fn(() => args.promise)
  const environment = vi.fn(async () => ({}))
  const record = agentSessionRecordFixture({
    sessionId: SESSION,
    provider: 'claude',
    permissionMode: 'auto',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/fixture/account' }
  })
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: () => {
      const held = record
      return held ? agentSessionConversationView(held) : undefined
    },
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => record.accountHome,
    recordWorkspacePath: async () => '/fixture/workspace',
    probes: {
      claude: createClaudeModelCatalogProbe({
        resolveLaunchArgs: resolving,
        resolveInheritedEnv: environment,
        resolveCommand: () => ({ command: '/fixture/claude', prefixArgs: [] }),
        resolveAuthPolicy: () => ({ account: 'system' })
      })
    }
  })
  const completion = Promise.withResolvers<void>()
  const optionsReady = vi.fn(() => completion.promise)
  let child: { phase: 'ready'; fence: number } | null = { phase: 'ready', fence: 1 }
  const resting = { child: null, params: { provider: 'claude' }, journal: restingJournal() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the full read only uses these context members.
  const context = {
    deps: {
      adapter: { readOptions: async () => ({ models: [], current: {} }) },
      agents: claudeAndCodexAgents(),
      store: {
        getConversation: () => {
          const held = record
          return held ? agentSessionConversationView(held) : undefined
        },
        getRecord: () => record
      },
      modelCatalog: catalog
    },
    deliveryOrder: { optionsReady },
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => ({ ...resting, child }),
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  try {
    const answer = readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: false
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolving).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    child = null
    completion.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(optionsReady).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(resolving).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20_001)
    await expect(answer).resolves.toMatchObject({ current: { permissionMode: 'auto' } })
    expect(resolving).toHaveBeenCalledOnce()
    args.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(environment).not.toHaveBeenCalled()
  } finally {
    completion.resolve()
    args.resolve([])
    catalog.stop()
    vi.useRealTimers()
  }
})
