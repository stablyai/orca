import { describe, expect, it, vi } from 'vitest'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'

function record(provider: string, saved: Record<string, string> | undefined): AgentSessionRecord {
  const { permissionMode, ...options } = saved ?? {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch mode reads only the record's id, agent, options and mode.
  return { sessionId: 'session-1', provider, options, permissionMode } as AgentSessionRecord
}

const listing = (
  models: { id: string; isDefault?: boolean; supportsAutoMode?: boolean }[]
): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  models: models.map((model) => ({
    label: model.id,
    efforts: [],
    isDefault: false,
    ...model
  }))
})

function launchPermission(
  provider: string,
  options: Record<string, string> | undefined,
  answer: AgentSessionModelCatalogResult | Error = { origin: 'unknown' }
) {
  const read = vi.fn(async () => {
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  })
  const modelCatalog = {
    peek: () => null,
    read,
    retainedLiveModelIds: vi.fn(async () => []),
    recordLiveListing: vi.fn(),
    prewarm: vi.fn(async () => undefined),
    stop: vi.fn(),
    providerStarted: vi.fn()
  }
  const deps = { agents: claudeAndCodexDeclared(), modelCatalog }
  return { read, result: structuredAgentSessionLaunchPermission(deps, record(provider, options)) }
}

describe('the permission mode a chat starts with', () => {
  it.each(AGENT_CHAT_PERMISSION_MODES)(
    'launches saved Claude %s without consulting the catalog',
    async (permissionMode) => {
      const launch = launchPermission(
        'claude',
        { permissionMode, model: 'haiku' },
        listing([{ id: 'haiku' }])
      )
      await expect(launch.result).resolves.toBe(permissionMode)
      expect(launch.read).not.toHaveBeenCalled()
    }
  )

  it('delegates saved own settings without consulting the catalog', async () => {
    for (const provider of ['claude', 'codex']) {
      const launch = launchPermission(
        provider,
        { permissionMode: 'own', model: 'unlisted-model' },
        new Error('catalog unavailable')
      )
      await expect(launch.result).resolves.toBe('own')
      expect(launch.read).not.toHaveBeenCalled()
    }
  })

  // Captured saved choices with an alias-only host catalog.
  it('keeps saved Haiku full-ID Auto with the captured alias-only catalog', async () => {
    const launch = launchPermission(
      'claude',
      { model: 'claude-haiku-4-5-20251001', permissionMode: 'auto' },
      listing([
        { id: 'opus', isDefault: true, supportsAutoMode: true },
        { id: 'fable', isDefault: false, supportsAutoMode: true },
        { id: 'sonnet', isDefault: false, supportsAutoMode: true },
        { id: 'haiku', isDefault: false, supportsAutoMode: true }
      ])
    )
    await expect(launch.result).resolves.toBe('auto')
    expect(launch.read).not.toHaveBeenCalled()
  })

  // #30032: a catalog saved under another account home read as none, and the chat relaunched asking.
  it('keeps saved auto with no selected model, unlisted models, or an unavailable catalog', async () => {
    const savedOptions: Record<string, string>[] = [{}, { model: 'claude-opus-5-5[1m]' }]
    for (const options of savedOptions) {
      const launch = launchPermission(
        'claude',
        { permissionMode: 'auto', ...options },
        new Error('catalog unavailable')
      )
      await expect(launch.result).resolves.toBe('auto')
      expect(launch.read).not.toHaveBeenCalled()
    }
    await expect(launchPermission('codex', { permissionMode: 'auto' }).result).resolves.toBe('auto')
  })

  it('asks for an absent or invalid saved mode, including modes the provider does not offer', async () => {
    await expect(launchPermission('claude', undefined).result).resolves.toBe('ask')
    await expect(
      launchPermission('claude', { permissionMode: 'bypassPermissions' }).result
    ).resolves.toBe('ask')
    await expect(
      launchPermission('codex', { permissionMode: 'accept-edits' }).result
    ).resolves.toBe('ask')
  })

  it('has none for an unregistered agent or one with no modes', async () => {
    await expect(launchPermission('grok', { permissionMode: 'full-access' }).result).resolves.toBe(
      null
    )
    await expect(launchPermission('pi', { permissionMode: 'full-access' }).result).resolves.toBe(
      null
    )
  })
})
