import { expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { record } from './structured-agent-session-restart-resume-test-harness'
import {
  readStructuredAgentSessionOptionsAtRest,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'

it.each(['claude', 'codex'])(
  'offers and persists Auto at rest for %s before capability discovery',
  async (provider) => {
    const saved = {
      ...record({ chain: [] }),
      provider,
      options: { model: 'm', permissionMode: 'ask' }
    }
    const deps = {
      store: { getRecord: () => saved },
      agents: {
        definition: () => (provider === 'claude' ? CLAUDE_STRUCTURED_AGENT : CODEX_STRUCTURED_AGENT)
      },
      modelCatalog: {
        read: async (): Promise<AgentSessionModelCatalogResult> => ({
          origin: 'live-session',
          fetchedAt: 1,
          models: [{ id: 'm', label: 'M', isDefault: true, efforts: [], supportsFastMode: true }]
        }),
        recordLiveListing: () => {},
        prewarm: async () => {},
        stop: () => {},
        providerStarted: () => {}
      }
    }
    const read = await readStructuredAgentSessionOptionsAtRest(deps, saved.sessionId)
    expect(read.permissionModes?.supported).toContain('auto')
    const persistOptions = vi.fn(async () => {})
    const picked = await recordStructuredAgentSessionOptionIntent(
      deps,
      {
        sessionId: saved.sessionId,
        persistOptions,
        publish: () => {}
      },
      { key: 'permissionMode', value: 'auto' }
    )
    expect(picked.ok).toBe(true)
    expect(persistOptions).toHaveBeenCalledWith({ model: 'm', permissionMode: 'auto' })
  }
)

it('preserves the migrated mode when an older resting chat changes another option', async () => {
  const saved = { ...record({ chain: [] }), options: { approvalsReviewer: 'auto_review' } }
  const persistOptions = vi.fn(async () => {})
  const picked = await recordStructuredAgentSessionOptionIntent(
    {
      store: { getRecord: () => saved },
      agents: { definition: () => CODEX_STRUCTURED_AGENT }
    },
    { sessionId: saved.sessionId, persistOptions, publish: () => {} },
    { key: 'model', value: 'm' }
  )
  expect(picked.ok).toBe(true)
  expect(persistOptions).toHaveBeenCalledWith({ model: 'm', permissionMode: 'auto' })
})
