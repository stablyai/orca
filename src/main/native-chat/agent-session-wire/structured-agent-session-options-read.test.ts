// A chat's options at rest come from the host catalog without waiting on a listing.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

function restingRecord(): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
  return {
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
    location: { wslDistro: null },
    options: {}
  } as unknown as AgentSessionRecord
}

describe('options at rest', () => {
  it('answers while the first catalog listing is still running', async () => {
    const record = restingRecord()
    const probe = vi.fn(() => new Promise<AgentModelCatalogSuccess>(() => {}))
    const modelCatalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: () => record,
      resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/homes/a' }),
      probes: { codex: probe }
    })
    const resting = { child: null, params: { provider: 'codex' } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
    const context = {
      deps: {
        adapter: {},
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => record },
        modelCatalog
      },
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => resting,
      conversation: async () => resting
    } as unknown as StructuredAgentSessionMutationContext

    const result = await readStructuredAgentSessionOptions(context, SESSION)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(result.models).toEqual([])
  })
})
