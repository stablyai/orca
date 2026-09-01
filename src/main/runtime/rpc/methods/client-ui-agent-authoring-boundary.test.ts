import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildAgentCatalogSnapshot } from '../../../agent-launch/agent-catalog-projections'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function collectStringsAndKeys(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsAndKeys(item, out)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key)
      collectStringsAndKeys(nested, out)
    }
  }
}

describe('client UI settings agent-authoring boundary', () => {
  it('rejects legacy agent-authoring settings.update fields without writing settings', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    // Kept in the schema so the payload parses and reaches the typed rejection.
    const upgradeRequiredPayloads = [
      { defaultTuiAgent: 'codex' },
      { disabledTuiAgents: ['claude'] },
      { agentDefaultArgs: { codex: '--flag' } },
      { agentDefaultEnv: { codex: { TOKEN: 'x' } } }
    ]
    for (const payload of upgradeRequiredPayloads) {
      const response = await dispatcher.dispatch(makeRequest('settings.update', payload))
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'client_upgrade_required', message: 'client_upgrade_required' }
      })
    }

    // Never-shipped catalog/reference keys are absent from the schema, so strict()
    // rejects them before the handler runs — still no write.
    const strictRejectedPayloads = [
      { customTuiAgents: [] },
      { deletedCustomTuiAgents: [] },
      { agentCatalogRevision: 2 },
      { agentReferenceRevision: 2 },
      { terminalQuickCommands: [] },
      { commitMessageAi: {} },
      { sourceControlAi: {} },
      { agentCmdOverrides: {} }
    ]
    for (const payload of strictRejectedPayloads) {
      const response = await dispatcher.dispatch(makeRequest('settings.update', payload))
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }

    expect(runtime.updateClientSettings).not.toHaveBeenCalled()
  })

  it('still applies non-agent settings.update fields', async () => {
    const applied = { defaultTaskSource: 'linear' }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn(() => applied)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('settings.update', { defaultTaskSource: 'linear', compactWorktreeCards: true })
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({
      defaultTaskSource: 'linear',
      compactWorktreeCards: true
    })
    expect(response).toMatchObject({ ok: true, result: { settings: applied } })
  })

  it('exposes no catalog/reference mutation method on the paired settings surface (oracle-15)', () => {
    // Read-only paired settings: catalog/reference AUTHORING is desktop preload IPC
    // only (settings:mutateAgentCatalog etc.), never a runtime RPC. A paired/mobile
    // client reaches the host solely through these methods, so the ONLY settings
    // writer is the key-guarded settings.update. This guard fails if a future
    // authoring RPC is added to the paired surface without a write-rejection —
    // exactly the walk's "mutation RPCs have no paired write-rejection" concern.
    const names = CLIENT_UI_METHODS.map((method) => method.name)
    const settingsMethods = names.filter((name) => name.startsWith('settings.'))
    expect(settingsMethods.sort()).toEqual([
      // Read-only catalog fetch; authoring stays desktop preload IPC.
      'settings.agentCatalog.get',
      'settings.agentReferences.get',
      'settings.get',
      // Terminal quick commands are plain settings state, not agent authoring.
      'settings.getTerminalQuickCommands',
      'settings.update',
      // main's PR-bot-author toggle: a plain settings writer, not agent
      // catalog/reference authoring — the mutationLike guard below still holds.
      'settings.updatePRBotAuthorOverride',
      'settings.updateTerminalQuickCommands'
    ])
    const mutationVerbs = new Set([
      'mutate',
      'create',
      'update',
      'delete',
      'set',
      'author',
      'rename',
      'duplicate',
      'disable',
      'enable',
      'write',
      'save'
    ])
    const authoringNoun = /agentcatalog|agentreference|customagent/i
    // Exact dot-segment match so a verb like `set` cannot false-match `settings`.
    const mutationLike = names.filter(
      (name) =>
        authoringNoun.test(name) &&
        name
          .toLowerCase()
          .split('.')
          .some((segment) => mutationVerbs.has(segment))
    )
    expect(mutationLike).toEqual([])
  })

  it('returns an env-free agent catalog with version 1 and the revision on settings.get', async () => {
    const settings = { defaultTaskSource: 'github' }
    // A live custom agent whose env holds a secret the projection must never emit.
    const catalogSettings = {
      customTuiAgents: [
        {
          id: 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd',
          baseAgent: 'codex',
          label: 'Secret Codex',
          args: '',
          env: { SECRET_TOKEN: 'super-secret-value' },
          syncEnv: true
        }
      ],
      agentCatalogRevision: 7
    } as unknown as GlobalSettings
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings),
      getAgentCatalogSnapshot: vi.fn(() => buildAgentCatalogSnapshot(catalogSettings)),
      getAgentReferenceRevision: vi.fn(() => 4)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('settings.get'))

    expect(response.ok).toBe(true)
    const result = (response as { result: Record<string, unknown> }).result
    expect(result.agentCatalog).toMatchObject({ version: 1, revision: 7 })
    expect(result.agentReferences).toEqual({ version: 1, revision: 4 })

    const strings: string[] = []
    collectStringsAndKeys(result, strings)
    expect(strings).not.toContain('SECRET_TOKEN')
    expect(strings).not.toContain('super-secret-value')
  })

  it('omits the catalog from settings.get when the client opts out, and serves it standalone', async () => {
    const catalogSettings = {
      customTuiAgents: [
        {
          id: 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd',
          baseAgent: 'codex',
          label: 'Secret Codex',
          args: '',
          env: { SECRET_TOKEN: 'super-secret-value' },
          syncEnv: true
        }
      ],
      agentCatalogRevision: 7
    } as unknown as GlobalSettings
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => ({ defaultTaskSource: 'github' })),
      getAgentCatalogSnapshot: vi.fn(() => buildAgentCatalogSnapshot(catalogSettings)),
      getAgentReferenceRevision: vi.fn(() => 4)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const opted = await dispatcher.dispatch(
      makeRequest('settings.get', { includeAgentCatalog: false })
    )
    expect(opted.ok).toBe(true)
    const optedResult = (opted as { result: Record<string, unknown> }).result
    expect(optedResult).not.toHaveProperty('agentCatalog')
    expect(optedResult.agentReferences).toEqual({ version: 1, revision: 4 })
    expect(runtime.getAgentCatalogSnapshot).not.toHaveBeenCalled()

    // Explicit true and omitted both keep the legacy piggyback for old clients.
    const included = await dispatcher.dispatch(
      makeRequest('settings.get', { includeAgentCatalog: true })
    )
    expect((included as { result: Record<string, unknown> }).result.agentCatalog).toMatchObject({
      version: 1,
      revision: 7
    })

    const standalone = await dispatcher.dispatch(makeRequest('settings.agentCatalog.get'))
    expect(standalone.ok).toBe(true)
    const standaloneResult = (standalone as { result: Record<string, unknown> }).result
    expect(standaloneResult.agentCatalog).toMatchObject({ version: 1, revision: 7 })
    expect(standaloneResult).not.toHaveProperty('settings')

    const strings: string[] = []
    collectStringsAndKeys(standaloneResult, strings)
    expect(strings).not.toContain('SECRET_TOKEN')
    expect(strings).not.toContain('super-secret-value')
  })
})
