// Write-policy suites for AgentCatalogService: the pre-v1 migration gate, the
// read-only newer-schema gate, the reference payload budget, and the
// durable-before-ack contract.
import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import { AgentCatalogService } from './agent-catalog-service'
import {
  baseSettings,
  makeStoreStub,
  type StoreStubState
} from './agent-catalog-service-test-fixtures'

describe('pre-v1 migration gate', () => {
  it('blocks catalog and reference mutations while the pinned pre-v1 backup has failed', () => {
    const state: StoreStubState = {
      settings: baseSettings(),
      repos: [],
      automations: [],
      agentCatalogMigrationError: 'disk full'
    }
    const service = new AgentCatalogService(makeStoreStub(state))
    const before = state.settings

    const catalogResult = service.mutate({
      expectedRevision: 1,
      mutation: {
        kind: 'create',
        baseAgent: 'codex',
        draft: { label: 'Blocked', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(catalogResult).toEqual({
      ok: false,
      code: 'agent_catalog_migration_blocked',
      migrationError: 'disk full'
    })

    const referenceResult = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: { kind: 'quick-command-delete', id: 'qc-1' }
    })
    expect(referenceResult).toEqual({
      ok: false,
      code: 'agent_catalog_migration_blocked',
      migrationError: 'disk full'
    })

    // No v1 write of any kind may land on the unbacked-up profile.
    expect(state.settings).toBe(before)
  })

  it('carries the block into the local snapshot so Settings surfaces it on load', () => {
    const state: StoreStubState = {
      settings: baseSettings(),
      repos: [],
      automations: [],
      agentCatalogMigrationError: 'disk full'
    }
    const service = new AgentCatalogService(makeStoreStub(state))
    expect(service.getLocalSnapshot().migrationBlockedError).toBe('disk full')

    state.agentCatalogMigrationError = null
    expect(service.getLocalSnapshot().migrationBlockedError).toBeUndefined()
  })

  it('projects the block to remote clients as a boolean only — never the error text', () => {
    const state: StoreStubState = {
      settings: baseSettings(),
      repos: [],
      automations: [],
      agentCatalogMigrationError: 'disk full at /Users/someone/Library'
    }
    const service = new AgentCatalogService(makeStoreStub(state))
    const remote = service.getRemoteSnapshot()
    expect('customAgents' in remote && remote.migrationBlocked).toBe(true)
    expect(JSON.stringify(remote)).not.toContain('disk full')
    expect(JSON.stringify(remote)).not.toContain('/Users/')

    state.agentCatalogMigrationError = null
    const healthy = service.getRemoteSnapshot()
    expect('migrationBlocked' in healthy).toBe(false)
  })
})

describe('schema-newer-than-supported read-only gate', () => {
  function readOnlyState(): StoreStubState {
    return {
      settings: baseSettings(),
      repos: [],
      automations: [],
      agentCatalogSchemaTooNew: { persistedVersion: 2, supportedVersion: 1 }
    }
  }

  it('rejects catalog and reference mutations up front instead of via the write refusal', () => {
    const state = readOnlyState()
    // A durable write here would be persistence's refusal, reported as a generic
    // failure; the gate must answer before any write is attempted.
    state.failDurableWrite = true
    const service = new AgentCatalogService(makeStoreStub(state))
    const before = state.settings

    expect(
      service.mutate({
        expectedRevision: 1,
        mutation: {
          kind: 'create',
          baseAgent: 'codex',
          draft: { label: 'Blocked', commandOverride: null, args: '', env: {}, syncEnv: false }
        }
      })
    ).toEqual({
      ok: false,
      code: 'agent_catalog_schema_too_new',
      persistedVersion: 2,
      supportedVersion: 1
    })

    expect(
      service.mutateReferences({
        expectedReferenceRevision: 1,
        mutation: { kind: 'quick-command-delete', id: 'qc-1' }
      })
    ).toEqual({
      ok: false,
      code: 'agent_catalog_schema_too_new',
      persistedVersion: 2,
      supportedVersion: 1
    })

    expect(state.settings).toBe(before)
  })

  it('carries the read-only state into the local snapshot so Settings surfaces it on load', () => {
    const state = readOnlyState()
    const service = new AgentCatalogService(makeStoreStub(state))
    expect(service.getLocalSnapshot().schemaTooNew).toEqual({
      persistedVersion: 2,
      supportedVersion: 1
    })

    state.agentCatalogSchemaTooNew = null
    expect(service.getLocalSnapshot().schemaTooNew).toBeUndefined()
  })

  it('leaves the remote projection unchanged: no new wire field for old clients', () => {
    const service = new AgentCatalogService(makeStoreStub(readOnlyState()))
    const remote = service.getRemoteSnapshot()
    expect('migrationBlocked' in remote).toBe(false)
    expect(JSON.stringify(remote)).not.toContain('schemaTooNew')
  })
})

describe('reference payload budget (L1-#2)', () => {
  function sourceControlAiWith(
    instructions: Partial<Record<'commitMessage' | 'pullRequest' | 'branchName', string>>
  ): GlobalSettings['sourceControlAi'] {
    return {
      enabled: true,
      agentId: null,
      actions: {},
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: '',
      instructionsByOperation: instructions
    } as GlobalSettings['sourceControlAi']
  }

  function serviceWith(settings: GlobalSettings): {
    service: AgentCatalogService
    state: StoreStubState
  } {
    const state: StoreStubState = { settings, repos: [], automations: [] }
    return { service: new AgentCatalogService(makeStoreStub(state)), state }
  }

  it('rejects a growing write that pushes the reference snapshot past 512 KiB', () => {
    const { service, state } = serviceWith(
      baseSettings({
        sourceControlAi: sourceControlAiWith({ commitMessage: 'x'.repeat(600_000) })
      })
    )
    const before = state.settings
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: {
        kind: 'source-control-update',
        changes: { customAgentCommand: 'generate-with-huge-profile' }
      }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'agent_reference_payload_too_large',
      referenceRevision: 1
    })
    // A rejected budget check performs no write.
    expect(state.settings).toBe(before)
  })

  it('still commits a shrinking write while the snapshot is over budget', () => {
    const { service, state } = serviceWith(
      baseSettings({
        sourceControlAi: sourceControlAiWith({
          commitMessage: 'x'.repeat(600_000),
          pullRequest: 'y'.repeat(600_000)
        })
      })
    )
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: {
        kind: 'source-control-update',
        changes: {
          instructionsByOperation: { commitMessage: '', pullRequest: 'y'.repeat(600_000) }
        }
      }
    })
    // Still > 512 KiB after the write, but smaller than before: the user must be
    // able to edit an over-budget profile back under budget.
    expect(result.ok).toBe(true)
    expect(state.settings.sourceControlAi?.instructionsByOperation?.commitMessage).toBe('')
  })

  it('keeps a small write under budget flowing normally', () => {
    const { service } = serviceWith(baseSettings())
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: { kind: 'source-control-update', changes: { customAgentCommand: 'ok' } }
    })
    expect(result.ok).toBe(true)
  })

  it('budgets the persisted projection, not the pre-persistence patch', () => {
    // Persistence derives legacy commitMessageAi from sourceControlAi, so an
    // under-budget patch lands as a projection carrying the instructions twice.
    const state: StoreStubState = {
      settings: baseSettings(),
      repos: [],
      automations: [],
      expandOnPersist: (updates) =>
        updates.sourceControlAi
          ? {
              commitMessageAi: {
                enabled: true,
                agentId: null,
                selectedModelByAgent: {},
                selectedThinkingByModel: {},
                customPrompt: updates.sourceControlAi.instructionsByOperation?.commitMessage ?? '',
                customAgentCommand: ''
              } as GlobalSettings['commitMessageAi']
            }
          : {}
    }
    const service = new AgentCatalogService(makeStoreStub(state))
    const before = state.settings
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: {
        kind: 'source-control-update',
        changes: { instructionsByOperation: { commitMessage: 'x'.repeat(300_000) } }
      }
    })
    expect(result).toMatchObject({ ok: false, code: 'agent_reference_payload_too_large' })
    expect(state.settings).toBe(before)
  })
})

describe('durable authoring acknowledgement (P0-2)', () => {
  function serviceWith(state: StoreStubState): AgentCatalogService {
    const store = makeStoreStub(state)
    // Any debounced write here would ack before the bytes are durable.
    Object.assign(store, {
      updateSettings: () => {
        throw new Error('authoring must not use the debounced settings write')
      }
    })
    return new AgentCatalogService(store)
  }

  const createCodex = {
    expectedRevision: 1,
    mutation: {
      kind: 'create' as const,
      baseAgent: 'codex' as const,
      draft: { label: 'Durable', commandOverride: null, args: '', env: {}, syncEnv: false }
    }
  }

  it('commits catalog and reference mutations through the durable write path', () => {
    const state: StoreStubState = { settings: baseSettings(), repos: [], automations: [] }
    const service = serviceWith(state)
    expect(service.mutate(createCodex).ok).toBe(true)
    expect(state.settings.customTuiAgents).toHaveLength(1)
    const referenceResult = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: { kind: 'source-control-update', changes: { customAgentCommand: 'ok' } }
    })
    expect(referenceResult.ok).toBe(true)
  })

  it('reports a typed failure and keeps state unchanged when the durable write fails', () => {
    const state: StoreStubState = {
      settings: baseSettings(),
      repos: [],
      automations: [],
      failDurableWrite: true
    }
    const service = serviceWith(state)
    const revisions: number[] = []
    service.onDidChange((revision) => revisions.push(revision))
    const before = state.settings

    expect(service.mutate(createCodex)).toEqual({
      ok: false,
      code: 'agent_catalog_write_failed',
      revision: 1
    })
    expect(
      service.mutateReferences({
        expectedReferenceRevision: 1,
        mutation: { kind: 'source-control-update', changes: { customAgentCommand: 'ok' } }
      })
    ).toEqual({
      ok: false,
      code: 'agent_reference_write_failed',
      referenceRevision: 1,
      catalogRevision: 1
    })
    expect(state.settings).toBe(before)
    expect(revisions).toEqual([])
  })
})
