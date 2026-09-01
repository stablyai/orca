import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  applyAgentStatusHooksEnabledMock,
  handleMock,
  mutateMock,
  recordManagedHookInstallFailureMock
} = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn(),
  handleMock: vi.fn(),
  mutateMock: vi.fn(),
  recordManagedHookInstallFailureMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock }
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../agent-hooks/install-telemetry', () => ({
  recordManagedHookInstallFailure: recordManagedHookInstallFailureMock
}))

vi.mock('../agent-launch/agent-catalog-service', () => ({
  getOrCreateAgentCatalogService: () => ({
    mutate: mutateMock,
    getRevision: () => 7,
    getLocalSnapshot: vi.fn(),
    getLocalDraft: vi.fn(),
    getReferenceSummaries: vi.fn(),
    getBaseDisableImpact: vi.fn(),
    getLocalReferenceSnapshot: vi.fn(),
    getReferenceRevision: vi.fn(),
    mutateReferences: vi.fn()
  })
}))

import { registerAgentCatalogHandlers } from './agent-catalog'

type MutateHandler = (
  event: unknown,
  request: { expectedRevision: number; mutation: Record<string, unknown> }
) => Promise<unknown>

const DISABLE_CODEX = { expectedRevision: 7, mutation: { kind: 'set-enabled' as const } }

function registerWithSettings(sequence: { disabledTuiAgents: string[] }[]): {
  handler: MutateHandler
} {
  const settings = sequence.map((entry) => ({ agentStatusHooksEnabled: true, ...entry }))
  let reads = 0
  const store = {
    getSettings: vi.fn(() => settings[Math.min(reads++, settings.length - 1)])
  }
  registerAgentCatalogHandlers(store as never)
  const handler = handleMock.mock.calls.find(
    (call) => call[0] === 'settings:mutateAgentCatalog'
  )?.[1] as MutateHandler
  return { handler }
}

describe('settings:mutateAgentCatalog', () => {
  beforeEach(() => {
    handleMock.mockReset()
    mutateMock.mockReset()
    applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
  })

  it('reconciles managed hooks when a mutation changes the disabled-agent set', async () => {
    mutateMock.mockReturnValue({ ok: true, revision: 8 })
    const { handler } = registerWithSettings([
      { disabledTuiAgents: [] },
      { disabledTuiAgents: ['codex'] }
    ])

    await handler(null, DISABLE_CODEX)

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ disabledTuiAgents: ['codex'] }),
      expect.objectContaining({ shouldContinue: expect.any(Function) })
    )
  })

  it('does not reconcile when the committed disabled-agent set is unchanged', async () => {
    mutateMock.mockReturnValue({ ok: true, revision: 8 })
    const { handler } = registerWithSettings([
      { disabledTuiAgents: ['codex', 'claude'] },
      { disabledTuiAgents: ['claude', 'codex'] }
    ])

    await handler(null, { expectedRevision: 7, mutation: { kind: 'set-default' } })

    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
  })

  it('does not reconcile when the mutation was rejected', async () => {
    mutateMock.mockReturnValue({ ok: false, code: 'catalog_revision_conflict', revision: 9 })
    const { handler } = registerWithSettings([{ disabledTuiAgents: [] }, { disabledTuiAgents: [] }])

    await handler(null, DISABLE_CODEX)

    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
  })

  it('still returns the mutation result when hook reconciliation throws', async () => {
    mutateMock.mockReturnValue({ ok: true, revision: 8 })
    applyAgentStatusHooksEnabledMock.mockRejectedValue(new Error('hook install failed'))
    const { handler } = registerWithSettings([
      { disabledTuiAgents: [] },
      { disabledTuiAgents: ['codex'] }
    ])

    await expect(handler(null, DISABLE_CODEX)).resolves.toEqual({ ok: true, revision: 8 })
  })

  it('rejects a malformed request without touching the service', async () => {
    const { handler } = registerWithSettings([{ disabledTuiAgents: [] }])

    await expect(handler(null, { expectedRevision: 'nope' } as never)).resolves.toEqual({
      ok: false,
      code: 'invalid_agent_field',
      revision: 7
    })
    expect(mutateMock).not.toHaveBeenCalled()
  })
})
