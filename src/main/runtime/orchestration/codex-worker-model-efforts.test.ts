import { describe, expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import {
  readCodexWorkerModelEfforts,
  type CodexWorkerModelCatalog
} from './codex-worker-model-efforts'

function catalog(result: AgentSessionModelCatalogResult | Error): CodexWorkerModelCatalog {
  return {
    read: async (params) => {
      expect(params).toEqual({ agent: 'codex', waitForListing: true })
      if (result instanceof Error) {
        throw result
      }
      return result
    }
  }
}

const listed: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  models: [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      isDefault: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({
        value,
        label: value
      }))
    },
    { id: 'gpt-no-effort', label: 'No effort', isDefault: false, efforts: [] }
  ]
}

describe('readCodexWorkerModelEfforts', () => {
  it('returns the efforts Codex lists for the model', async () => {
    await expect(readCodexWorkerModelEfforts(catalog(listed), 'gpt-6.1-sol')).resolves.toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra'
    ])
  })

  it.each([
    ['an unlisted (or hidden) model', listed, 'gpt-reserve'],
    ['a model listed without efforts', listed, 'gpt-no-effort'],
    ['an unavailable listing', { origin: 'unknown' } as const, 'gpt-6.1-sol'],
    ['a failed read', new Error('codex app-server exited'), 'gpt-6.1-sol']
  ])('falls back to the static catalog for %s', async (_case, result, model) => {
    await expect(readCodexWorkerModelEfforts(catalog(result), model)).resolves.toBeNull()
  })
})
