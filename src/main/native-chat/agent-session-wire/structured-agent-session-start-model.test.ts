// A start launches the model the catalog settles for the chat's saved selection, and never waits on
// the catalog to start: a failed read launches the selection as saved.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { attachParams, CALLER, hostTestState } from './structured-agent-session-host-test-harness'
import type { AgentSessionModelSource } from '../../../shared/agent-session-options-replacement'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

/** A new Claude chat whose saved model a picker chose, unless `modelSource` says otherwise. */
function claudeChat(
  options: Record<string, string>,
  modelSource: AgentSessionModelSource | null = 'picker'
) {
  return attachParams({
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    providerHandle: undefined,
    options,
    ...(modelSource ? { modelSource } : {})
  })
}

function catalogFake() {
  return {
    recordLiveListing: vi.fn(),
    prewarm: vi.fn(async () => {}),
    stop: vi.fn(),
    providerStarted: vi.fn()
  }
}

let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(() => {
  ;({ host, acquire } = hostTestState())
  const started = acquire.getMockImplementation()!
  // The harness's child proves a Codex thread; a Claude chat's proves a Claude session.
  acquire.mockImplementation(async (input) => {
    const acquired = await started(input)
    return host.deps.store.getRecord(SESSION)?.provider === 'claude'
      ? { ...acquired, link: { ...acquired.link, handle: claudeProviderHandle('claude-1', null) } }
      : acquired
  })
})

describe('the model a start launches', () => {
  it.each([
    ['gone from the current list', true, { model: 'sonnet', effort: 'high' }],
    ['unverified', false, { model: 'opus', effort: 'high' }]
  ])(
    'starts a chat whose saved model is %s on what the catalog settles',
    async (_, verified, launched) => {
      const read = vi.fn(async () => ({
        origin: 'probe' as const,
        models: [
          {
            id: 'sonnet',
            label: 'Sonnet',
            isDefault: true,
            efforts: [{ value: 'high', label: 'High' }]
          }
        ],
        fetchedAt: NOW,
        ...(verified ? { unlistedModelReplacement: 'sonnet' } : {})
      }))
      host.deps.modelCatalog = { ...catalogFake(), read }

      const params = claudeChat({ model: 'opus', effort: 'high' })
      expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION, forStart: true })
      )
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ options: launched }))
    }
  )

  it('starts on the saved options when the catalog cannot be read', async () => {
    host.deps.modelCatalog = {
      ...catalogFake(),
      read: vi.fn(async () => {
        throw new Error('catalog unavailable')
      })
    }
    const params = claudeChat({ model: 'opus', effort: 'high' })
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ options: { model: 'opus', effort: 'high' } })
    )
  })

  it.each([
    ['a caller named it', claudeChat({ model: 'claude-sonnet-4-5' }, 'caller')],
    ['the record predates who chose it', claudeChat({ model: 'claude-sonnet-4-5' }, null)],
    ['the agent never replaces one', attachParams({ options: { model: 'gpt-gone' } })]
  ])('starts a saved model as given, reading no catalog, when %s', async (_, params) => {
    const read = vi.fn(async () => ({
      origin: 'probe' as const,
      models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true, efforts: [] }],
      fetchedAt: NOW,
      unlistedModelReplacement: 'sonnet'
    }))
    host.deps.modelCatalog = { ...catalogFake(), read }
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    expect(read).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ options: params.options }))
  })
})
