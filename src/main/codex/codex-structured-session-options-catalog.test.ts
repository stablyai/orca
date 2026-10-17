import { describe, expect, it, vi } from 'vitest'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSession } from './codex-structured-session-state'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
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
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null,
    catalogAccess: { store, fingerprint: FINGERPRINT, accountHomePath: '/homes/a' }
  }
}

function seedEntry(store: AgentModelCatalogStore, ...ids: string[]): void {
  store.recordSuccess(
    FINGERPRINT,
    'codex',
    {
      models: ids.map((id, index) => ({
        id,
        label: id.toUpperCase(),
        isDefault: index === 0,
        efforts: [{ value: 'high', label: 'High' }],
        defaultEffort: 'high'
      })),
      origin: 'live-session'
    },
    'discovery'
  )
}

describe('Codex session options through independent discovery', () => {
  it('reads current facts while cold, never discovering or publishing from the chat', async () => {
    const store = new AgentModelCatalogStore()
    const request = vi.fn(async () => listAnswer('gpt-live'))
    const session = storeSession(request, store)
    expect(await readLiveCodexSessionOptions(session, undefined)).toMatchObject({
      models: [],
      current: { model: 'gpt-live' }
    })
    session.reportedOptions = {}
    expect(await readLiveCodexSessionOptions(session, undefined)).toMatchObject({
      models: [],
      current: {}
    })
    expect(request).not.toHaveBeenCalled()
    expect(store.get(FINGERPRINT)).toBeNull()
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'unlisted-intent')
    ).resolves.toMatchObject({ model: 'unlisted-intent' })
  })

  it('uses one whole discovery observation, including stale display and later replacement', async () => {
    let now = 0
    const store = new AgentModelCatalogStore({ now: () => now })
    seedEntry(store, 'gpt-live')
    const request = vi.fn(async () => listAnswer('wrong-session-list'))
    const session = storeSession(request, store)
    now += AGENT_MODEL_CATALOG_FRESH_MS
    expect(
      (await readLiveCodexSessionOptions(session, undefined)).models.map((row) => row.id)
    ).toEqual(['gpt-live'])
    seedEntry(store, 'gpt-next')
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-next')
    ).resolves.toMatchObject({ model: 'gpt-next' })
    await expect(applyCodexStructuredSessionOption(session, 'model', 'missing')).rejects.toThrow(
      'does not offer'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('budgets all pages and config/read against one 30-second deadline', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const timeouts: number[] = []
    const request = vi.fn(
      async (
        method: string,
        _params?: Record<string, unknown>,
        options?: { timeoutMs?: number }
      ) => {
        timeouts.push(options?.timeoutMs ?? 0)
        if (method === 'model/list') {
          now += 15_001
          return { data: [modelRow('gpt-live')], nextCursor: timeouts.length === 1 ? 'more' : null }
        }
        return { config: {} }
      }
    )
    try {
      await expect(
        fetchCodexModelCatalogListing({ connection: { request }, deadlineMs: 30_000 })
      ).rejects.toThrow('deadline exceeded')
      expect(request.mock.calls.map(([method]) => method)).toEqual(['model/list', 'model/list'])
      expect(timeouts).toEqual([30_000, 14_999])
    } finally {
      clock.mockRestore()
    }
  })
})
