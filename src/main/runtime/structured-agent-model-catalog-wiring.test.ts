import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentModelCatalogSuccess } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type * as CatalogStoreModule from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentModelCatalogStore,
  AGENT_MODEL_CATALOG_FRESH_MS
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { claudeAndCodexAgents } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { modelCatalogHostDeps } from './structured-agent-model-catalog-wiring'

const clock = vi.hoisted(() => ({ now: 1_000 }))
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-store', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogStoreModule>()
  return {
    ...actual,
    agentModelCatalogStore: new actual.AgentModelCatalogStore({ now: () => clock.now })
  }
})

const SAVED_MODEL = {
  id: 'sonnet',
  label: 'Remembered model',
  description: 'Remembered description',
  isDefault: true,
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ],
  defaultEffort: 'high',
  supportsFastMode: false
}

let nextAccount = 0
async function hostCatalog(input: { agent?: 'claude' | 'codex'; stale?: boolean; model?: string }) {
  const agent = input.agent ?? 'claude'
  const home = {
    variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    path: `/accounts/catalog-test-${++nextAccount}`
  }
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ claimStatus: 'released', ownerProcess: null })
  )
  record.provider = agent
  record.accountHome = home
  record.location.workspaceKind = 'folder'
  record.options = input.model ? { model: input.model } : {}
  if (input.model) {
    record.modelChosenBy = 'picker'
  }
  const fingerprint = agentModelCatalogFingerprint({ agent, accountHome: home, wslDistro: null })
  const saved: AgentModelCatalogSuccess = {
    models: [SAVED_MODEL],
    fastModeSupport: { supported: false },
    origin: 'probe'
  }
  agentModelCatalogStore.recordSuccess(fingerprint, agent, saved, 'discovery')
  if (input.stale) {
    clock.now += AGENT_MODEL_CATALOG_FRESH_MS
    const failedProbe = async () => {
      throw new Error('temporarily unavailable')
    }
    await agentModelCatalogStore.refresh(fingerprint, agent, failedProbe, failedProbe)
    expect(agentModelCatalogStore.hasActiveFailure(fingerprint)).toBe(true)
  }
  vi.spyOn(agentModelCatalogStore, 'attachPersistence').mockResolvedValue()
  const { modelCatalog } = await modelCatalogHostDeps({
    store: { getRecord: () => record, listRecords: () => [record] },
    agents: claudeAndCodexAgents(),
    // No registered lister: a saved catalog read must not launch an agent.
    registrations: [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with no registration and a pinned record, the read resolves only the account home.
    deps: {
      stateDirectory: '/unused/catalog-test-state',
      resolveAgentAccountHome: async () => home,
      resolveWorkspacePath: async () => null
    } as unknown as Parameters<typeof modelCatalogHostDeps>[0]['deps'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no registration reads the environment.
    environment: {} as Parameters<typeof modelCatalogHostDeps>[0]['environment']
  })
  if (!modelCatalog) {
    throw new Error('the host has a catalog service')
  }
  return modelCatalog.read({ agent, sessionId: record.sessionId })
}

afterEach(() => vi.restoreAllMocks())

describe('the runtime host catalog for session pickers', () => {
  it.each(['sonnet', 'gone-model'])(
    "names the replacement for a Claude chat's model %s only while its list is current",
    async (model) => {
      expect(await hostCatalog({ model })).toMatchObject({
        models: [{ id: 'sonnet', efforts: SAVED_MODEL.efforts }],
        unlistedModelReplacement: 'sonnet'
      })
      const stale = await hostCatalog({ model, stale: true })
      expect(stale).toMatchObject({ models: [{ id: 'sonnet' }] })
      expect(stale).not.toHaveProperty('unlistedModelReplacement')
    }
  )

  it('names no replacement for an agent that keeps its own model policy', async () => {
    expect(await hostCatalog({ agent: 'codex', model: 'gone-model' })).not.toHaveProperty(
      'unlistedModelReplacement'
    )
  })
})
