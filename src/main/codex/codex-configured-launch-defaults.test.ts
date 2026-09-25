import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'

function modelRow(id: string, isDefault = false): Record<string, unknown> {
  return {
    model: id,
    displayName: id.toUpperCase(),
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ],
    defaultReasoningEffort: 'medium',
    isDefault
  }
}

// Codex marks its recommended model; the user's config names another.
function connection(
  configRead: { answer: unknown } | { error: Error }
): Pick<CodexAppServerConnection, 'request'> & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async (method: string) => {
      if (method === 'model/list') {
        return { data: [modelRow('gpt-6-astra', true), modelRow('gpt-5.5')], nextCursor: null }
      }
      if (method === 'config/read') {
        if ('error' in configRead) {
          throw configRead.error
        }
        return configRead.answer
      }
      throw new Error(`unexpected ${method}`)
    })
  }
}

function defaults(models: { id: string; isDefault: boolean; defaultEffort?: string }[]) {
  return models.map(({ id, isDefault, defaultEffort }) => ({ id, isDefault, defaultEffort }))
}

describe('Codex listing default follows the configured launch model', () => {
  it('marks the configured model and effort as what a launch runs', async () => {
    const listing = await fetchCodexModelCatalogListing({
      connection: connection({
        answer: { config: { model: 'gpt-5.5', model_reasoning_effort: 'xhigh' } }
      })
    })
    expect(defaults(listing.models)).toEqual([
      { id: 'gpt-6-astra', isDefault: false, defaultEffort: 'medium' },
      { id: 'gpt-5.5', isDefault: true, defaultEffort: 'xhigh' }
    ])
  })

  it('applies a configured effort to the listed default when no model is configured', async () => {
    const listing = await fetchCodexModelCatalogListing({
      connection: connection({
        answer: { config: { model: null, model_reasoning_effort: 'high' } }
      })
    })
    expect(defaults(listing.models)).toEqual([
      { id: 'gpt-6-astra', isDefault: true, defaultEffort: 'high' },
      { id: 'gpt-5.5', isDefault: false, defaultEffort: 'medium' }
    ])
  })

  it('names no default when the configured model is one the listing does not offer', async () => {
    const listing = await fetchCodexModelCatalogListing({
      connection: connection({
        answer: { config: { model: 'gpt-oss:20b', model_reasoning_effort: 'high' } }
      })
    })
    expect(defaults(listing.models)).toEqual([
      { id: 'gpt-6-astra', isDefault: false, defaultEffort: 'medium' },
      { id: 'gpt-5.5', isDefault: false, defaultEffort: 'medium' }
    ])
  })

  it('ignores a configured effort the listed default cannot run', async () => {
    const listing = await fetchCodexModelCatalogListing({
      connection: connection({ answer: { config: { model: null, model_reasoning_effort: 'max' } } })
    })
    expect(defaults(listing.models)).toEqual([
      { id: 'gpt-6-astra', isDefault: true, defaultEffort: 'medium' },
      { id: 'gpt-5.5', isDefault: false, defaultEffort: 'medium' }
    ])
  })

  it('keeps the listing as Codex sent it when config/read is unavailable', async () => {
    const rpc = connection({ error: new Error('Method not found: config/read') })
    const listing = await fetchCodexModelCatalogListing({ connection: rpc })
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(['model/list', 'config/read'])
    expect(defaults(listing.models)).toEqual([
      { id: 'gpt-6-astra', isDefault: true, defaultEffort: 'medium' },
      { id: 'gpt-5.5', isDefault: false, defaultEffort: 'medium' }
    ])
  })
})
