import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { expect, it } from 'vitest'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'

it.each([null, 'second-page'])(
  'ends the actual retired probe before a later catalog stage: cursor=%s',
  async (nextCursor) => {
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    const requests: string[] = []
    let signal: AbortSignal | undefined
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/fixture', HOME: '/fixture' }),
      resolveCommand: () => '/fixture/codex',
      runSession: async (invocation, body) => {
        signal = invocation.signal
        try {
          return await body({
            notify: () => {},
            request: async (method) => {
              requests.push(method)
              if (method === 'model/list') {
                ready.resolve()
                await release.promise
                return {
                  data: [{ model: 'gpt-live', supportedReasoningEfforts: [], isDefault: true }],
                  nextCursor
                }
              }
              return method === 'config/read' ? { config: { model: 'gpt-live' } } : {}
            }
          })
        } finally {
          done.resolve()
        }
      }
    })
    const record = agentSessionRecordFixture({
      sessionId: 'retired-codex',
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/fixture/codex-home' }
    })
    const store = new AgentModelCatalogStore()
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => {
        const held = record
        return held ? agentSessionConversationView(held) : undefined
      },
      getRecord: () => record,
      drivesRecord: () => true,
      resolveAccountHome: async () => record.accountHome,
      recordWorkspacePath: async () => '/fixture/workspace',
      probes: { codex: probe }
    })
    try {
      const demand = service.demand({ agent: 'codex', sessionId: record.sessionId })
      await ready.promise
      expect(requests).toEqual(['model/list', 'account/read'])
      store.expireAgent('codex')
      await demand
      expect(signal?.aborted).toBe(false)
      release.resolve()
      await done.promise
      expect(requests).toEqual(['model/list', 'account/read'])
      expect(service.snapshot({ agent: 'codex', sessionId: record.sessionId })).toEqual({
        origin: 'unknown'
      })
    } finally {
      release.resolve()
      service.stop()
    }
  }
)
