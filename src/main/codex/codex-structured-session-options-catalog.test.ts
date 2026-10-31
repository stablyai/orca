import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import { projectCodexSessionOptions } from './codex-structured-service-tier'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { optionSession } from './codex-structured-option-session.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  composeCodexSessionOptionCatalog,
  fetchCodexModelCatalogListing
} from './codex-structured-model-catalog'

function modelRow(id: string): Record<string, unknown> {
  return {
    model: id,
    displayName: id.toUpperCase(),
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
  }
}

describe('first-turn catalog deadline', () => {
  it('budgets all pages and config/read against one 30-second deadline', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const timeouts: number[] = []
    const request = vi.fn(
      async (
        method: string,
        _params?: Record<string, unknown>,
        options?: { timeoutMs?: number | null }
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

it('uses installed choices after an update and keeps saved values for the next turn', async () => {
  const request = vi.fn(async () => {
    throw new Error('child catalog must not be read')
  })
  const session = optionSession(request)
  session.options = new Map([
    ['model', 'A'],
    ['effort', 'low']
  ])
  session.appliedTurnOptions = { model: 'A', effort: 'low' }
  const store = new AgentModelCatalogStore()
  const install = (models: AgentSessionOptionsResult['models']) =>
    store.recordSuccess('scope', 'codex', { origin: 'probe', complete: true, models }, 'discovery')
  install([{ id: 'A', label: 'A', isDefault: true, efforts: [{ value: 'high', label: 'High' }] }])
  session.catalogAccess = {
    store,
    fingerprint: 'scope',
    accountHomePath: '/account',
    demand: async () => {}
  }
  const before = await readLiveCodexSessionOptions(session, 100)
  expect(before.models[0]?.efforts).toEqual([{ value: 'high', label: 'High' }])
  expect(before.current).toMatchObject({ model: 'A', effort: 'low' })
  await expect(applyCodexStructuredSessionOption(session, 'effort', 'low')).resolves.toMatchObject({
    effort: 'low'
  })
  install([{ id: 'B', label: 'B', isDefault: true, efforts: [] }])
  const after = await readLiveCodexSessionOptions(session, 100)
  expect(after.models.map((row) => row.id)).toEqual(['B', 'A'])
  expect(after.models[1]).toMatchObject({ efforts: [], effortsKnown: false })
  expect(after.current).toMatchObject({ model: 'A', effort: 'low' })
  expect(projectCodexSessionOptions(session, Object.fromEntries(session.options))?.options).toEqual(
    { model: 'A', effort: 'low' }
  )
  expect(request).not.toHaveBeenCalled()
})

it('keeps declared context independent from configured policy and actual Codex effort', async () => {
  for (const [configuredEffort, policy, declared] of [
    [undefined, 'high', 'high'],
    ['low', 'low', 'low'],
    ['unlisted', 'high', null]
  ] as const) {
    const listing = await fetchCodexModelCatalogListing({
      connection: {
        request: async (method) =>
          method === 'model/list'
            ? {
                data: [
                  {
                    model: 'native',
                    displayName: 'Native',
                    isDefault: true,
                    defaultReasoningEffort: 'high',
                    supportedReasoningEfforts: ['low', 'high'].map((reasoningEffort) => ({
                      reasoningEffort
                    }))
                  }
                ],
                nextCursor: null
              }
            : { config: { model: 'native', model_reasoning_effort: configuredEffort } }
      }
    })
    expect(listing.models[0]).toMatchObject({
      defaultEffort: policy,
      declaredDefaultEffort: declared
    })
    expect(
      composeCodexSessionOptionCatalog(listing, { current: { model: 'native', effort: 'max' } })
        .current
    ).toMatchObject({ model: 'native', effort: 'max' })
  }
})
