import { describe, expect, it, vi } from 'vitest'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSession } from './codex-structured-session-state'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AGENT_MODEL_CATALOG_VALIDATION_MIN_AGE_MS,
  AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

const FINGERPRINT = 'fp-session-account'

function modelRow(id: string, isDefault = false): Record<string, unknown> {
  return {
    model: id,
    displayName: id.toUpperCase(),
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    defaultReasoningEffort: 'high',
    isDefault
  }
}

function listAnswer(...ids: string[]): { data: Record<string, unknown>[]; nextCursor: null } {
  return { data: ids.map((id, index) => modelRow(id, index === 0)), nextCursor: null }
}

// Each listing also reads the configured defaults; count the provider fetches only.
function modelListCalls(request: { mock: { calls: unknown[][] } }): number {
  return request.mock.calls.filter(([method]) => method === 'model/list').length
}

function storeSession(
  request: CodexAppServerConnection['request'],
  store: AgentModelCatalogStore
): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    requestedClose: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    historyPath: null,
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    fastModeTierByModel: new Map(),
    dispatchEchoes: createCodexDispatchEchoes(),
    translator: null,
    catalogAccess: { store, fingerprint: FINGERPRINT, accountHomePath: '/homes/a' }
  }
}

function seedEntry(store: AgentModelCatalogStore, ...ids: string[]): void {
  store.recordSuccess(FINGERPRINT, 'codex', {
    models: ids.map((id, index) => ({
      id,
      label: id.toUpperCase(),
      isDefault: index === 0,
      efforts: [{ value: 'high', label: 'High' }],
      defaultEffort: 'high'
    })),
    fastModeTierByModel: new Map(),
    origin: 'live-session'
  })
}

describe('Codex session options through the host catalog store', () => {
  it('lists once at the first read and serves every later read from the store', async () => {
    const store = new AgentModelCatalogStore()
    const request = vi.fn(async () => listAnswer('gpt-live', 'gpt-next'))
    const session = storeSession(request, store)
    // The acquire-time restore read.
    const first = await readLiveCodexSessionOptions(session, undefined)
    expect(first.models.map((model) => model.id)).toEqual(['gpt-live', 'gpt-next'])
    expect(modelListCalls(request)).toBe(1)
    // The picker's first read after attach must not pay a second listing.
    const second = await readLiveCodexSessionOptions(session, undefined)
    expect(second.models.map((model) => model.id)).toEqual(['gpt-live', 'gpt-next'])
    expect(modelListCalls(request)).toBe(1)
    // The write-through landed under the session's spawn-pinned key only.
    expect(store.get(FINGERPRINT)!.models.map((model) => model.id)).toEqual([
      'gpt-live',
      'gpt-next'
    ])
    expect(store.get('some-other-account')).toBeNull()
  })

  it('answers the picker with zero provider fetches when the store is already warm', async () => {
    const store = new AgentModelCatalogStore()
    seedEntry(store, 'gpt-live', 'gpt-next')
    const request = vi.fn(async () => listAnswer('gpt-live'))
    const session = storeSession(request, store)
    const result = await readLiveCodexSessionOptions(session, undefined)
    expect(result.models.map((model) => model.id)).toEqual(['gpt-live', 'gpt-next'])
    expect(result.current.model).toBe('gpt-live')
    expect(request).not.toHaveBeenCalled()
  })

  it('serves a stale entry immediately and refreshes it behind the answer', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    seedEntry(store, 'gpt-live')
    at += AGENT_MODEL_CATALOG_FRESH_MS
    const request = vi.fn(async () => listAnswer('gpt-live', 'gpt-new'))
    const session = storeSession(request, store)
    const result = await readLiveCodexSessionOptions(session, undefined)
    // The stale models answer the read; the refetch happens off this path.
    expect(result.models.map((model) => model.id)).toEqual(['gpt-live'])
    await vi.waitFor(() => {
      expect(store.get(FINGERPRINT)!.models.map((model) => model.id)).toEqual([
        'gpt-live',
        'gpt-new'
      ])
    })
    expect(modelListCalls(request)).toBe(1)
  })

  it('never blocks a read behind an in-flight background refresh', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    seedEntry(store, 'gpt-live')
    at += AGENT_MODEL_CATALOG_FRESH_MS
    // The provider never answers; the stale entry must still answer instantly.
    const request = vi.fn(() => new Promise<never>(() => {}))
    const session = storeSession(request, store)
    const result = await readLiveCodexSessionOptions(session, undefined)
    expect(result.models.map((model) => model.id)).toEqual(['gpt-live'])
    expect(modelListCalls(request)).toBe(1)
  })

  it('waits for one refresh when the picked model is missing from a stale entry', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    seedEntry(store, 'gpt-live')
    at += AGENT_MODEL_CATALOG_VALIDATION_MIN_AGE_MS
    const request = vi.fn(async () => listAnswer('gpt-live', 'gpt-next'))
    const session = storeSession(request, store)
    const committed = await applyCodexStructuredSessionOption(session, 'model', 'gpt-next', 5_000)
    expect(committed.model).toBe('gpt-next')
    expect(modelListCalls(request)).toBe(1)
  })

  it('refuses a model missing from a young entry without refetching', async () => {
    const store = new AgentModelCatalogStore()
    seedEntry(store, 'gpt-live')
    const request = vi.fn(async () => listAnswer('gpt-live', 'gpt-next'))
    const session = storeSession(request, store)
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-next', 5_000)
    ).rejects.toThrow(/does not offer model gpt-next/)
    expect(request).not.toHaveBeenCalled()
  })

  it('falls back to the stored entry when the validation refresh fails', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    seedEntry(store, 'gpt-live')
    at += AGENT_MODEL_CATALOG_VALIDATION_MIN_AGE_MS
    const request = vi.fn(async () => {
      throw new Error('provider gone')
    })
    const session = storeSession(request, store)
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-next', 5_000)
    ).rejects.toThrow(/does not offer model gpt-next/)
    expect(modelListCalls(request)).toBe(1)
    // The failed refresh never displaced the last good listing.
    expect(store.get(FINGERPRINT)!.models.map((model) => model.id)).toEqual(['gpt-live'])
  })
})
