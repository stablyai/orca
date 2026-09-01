import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo, TuiAgent, WorktreeMeta } from '../../shared/types'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { AgentCatalogService } from './agent-catalog-service'
import { getHostAgentSessionRecordStore } from './agent-session-record-store-host'
import type { HostSessionLaunchRecord } from './agent-session-record-store'
import { getHostBackgroundAgentLaunchStore } from './background-agent-launch-store-host'
import {
  UUID_A,
  UUID_B,
  agentQuickCommand,
  baseSettings,
  customId,
  liveAgent,
  makeStoreStub,
  tombstoneFor,
  type StoreStubState
} from './agent-catalog-service-test-fixtures'

describe('tombstone reference GC across owners', () => {
  const deadId = customId('codex', UUID_B)

  function serviceWith(state: Partial<StoreStubState>): {
    service: AgentCatalogService
    state: StoreStubState
  } {
    const fullState: StoreStubState = {
      settings: baseSettings(),
      repos: [],
      automations: [],
      ...state
    }
    return { service: new AgentCatalogService(makeStoreStub(fullState)), state: fullState }
  }

  it('retains the tombstone while the default references it and prunes after the last reference clears', () => {
    const { service, state } = serviceWith({
      settings: baseSettings({
        defaultTuiAgent: deadId,
        deletedCustomTuiAgents: [tombstoneFor(deadId)]
      })
    })
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(1)

    // Create with prune: tombstone retained because the default still points at it.
    const created = service.mutate({
      expectedRevision: 1,
      mutation: {
        kind: 'create',
        baseAgent: 'claude',
        draft: { label: 'Other', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(created.ok).toBe(true)
    expect(state.settings.deletedCustomTuiAgents).toHaveLength(1)

    // Clear the default (last reference), then the next prune removes it.
    const cleared = service.mutate({
      expectedRevision: state.settings.agentCatalogRevision ?? 1,
      mutation: { kind: 'set-default', agent: 'auto' }
    })
    expect(cleared.ok).toBe(true)
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(0)
    const created2 = service.mutate({
      expectedRevision: state.settings.agentCatalogRevision ?? 1,
      mutation: {
        kind: 'create',
        baseAgent: 'gemini',
        draft: { label: 'Another', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(created2.ok).toBe(true)
    expect(state.settings.deletedCustomTuiAgents).toHaveLength(0)
  })

  it('counts quick-command, commit-message, source-control (global and repo), and automation references', () => {
    const { service } = serviceWith({
      settings: baseSettings({
        terminalQuickCommands: [agentQuickCommand(deadId)],
        commitMessageAi: {
          enabled: true,
          agentId: deadId,
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: ''
        },
        sourceControlAi: {
          enabled: true,
          agentId: deadId,
          actions: { 'commit-message': { agentId: deadId, commandInputTemplate: '' } },
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customAgentCommand: '',
          instructionsByOperation: {}
        } as GlobalSettings['sourceControlAi'],
        deletedCustomTuiAgents: [tombstoneFor(deadId)]
      }),
      repos: [
        {
          id: 'repo-1',
          sourceControlAi: {
            actionOverrides: { 'pr-review': { agentId: deadId, commandInputTemplate: '' } }
          }
        } as unknown as Repo
      ],
      automations: [{ id: 'auto-1', agentId: deadId } as unknown as Automation]
    })
    // quick-command 1 + commit-message agentId 1 + sourceControlAi agentId 1 +
    // action recipe 1 + repo override 1 + automation 1 = 6
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(6)
    const summary = service.getReferenceSummaries(deadId)
    expect(summary).toContainEqual({ owner: 'quick-command', count: 1 })
    expect(summary).toContainEqual({ owner: 'commit-message', count: 2 })
    expect(summary).toContainEqual({ owner: 'source-control-recipe', count: 2 })
    expect(summary).toContainEqual({ owner: 'automation', count: 1 })
  })

  it('retains via a run launch-failure even after the definition agent changed, and prunes after the run clears', () => {
    // The automation definition points at a live agent now, but a past run's
    // structured launch failure still references the deleted custom id — the
    // tombstone must stay retained until that run record is gone too.
    const { service, state } = serviceWith({
      settings: baseSettings({ deletedCustomTuiAgents: [tombstoneFor(deadId)] }),
      automations: [{ id: 'auto-1', agentId: 'claude' } as unknown as Automation],
      automationRuns: [
        {
          id: 'run-1',
          agentLaunchFailure: {
            version: 1,
            code: 'base_agent_disabled',
            requestedAgent: deadId,
            failureId: 'rf-1',
            intent: 'automation',
            occurredAt: 1
          }
        } as unknown as AutomationRun
      ]
    })
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(1)
    expect(service.getReferenceSummaries(deadId)).toContainEqual({ owner: 'automation', count: 1 })

    state.automationRuns = []
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(0)
  })

  it('counts workspace pending-launch and durable-failure references and prunes after the last clears', () => {
    const { service, state } = serviceWith({
      settings: baseSettings({ deletedCustomTuiAgents: [tombstoneFor(deadId)] }),
      worktreeMeta: {
        'wt-1': {
          pendingAgentLaunch: { operationId: 'op-1', requestedAgent: deadId }
        } as unknown as WorktreeMeta,
        'wt-2': {
          agentLaunchFailure: {
            version: 1,
            code: 'spawn_failed',
            requestedAgent: deadId,
            failureId: 'f-1',
            intent: 'interactive',
            occurredAt: 1
          }
        } as unknown as WorktreeMeta
      }
    })
    // pendingAgentLaunch.requestedAgent + agentLaunchFailure.requestedAgent = 2.
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(2)
    expect(service.getReferenceSummaries(deadId)).toContainEqual({ owner: 'workspace', count: 2 })

    // Last reference cleared -> the tombstone can prune.
    state.worktreeMeta = {}
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(0)
  })

  it('retains the tombstone when the workspace store is unavailable', () => {
    const { service } = serviceWith({
      settings: baseSettings({ deletedCustomTuiAgents: [tombstoneFor(deadId)] }),
      failWorktreeScan: true
    })
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe('unknown')
  })

  it('treats an unavailable owner store as unknown and retains the tombstone', () => {
    const { service, state } = serviceWith({
      settings: baseSettings({
        deletedCustomTuiAgents: [tombstoneFor(deadId)]
      }),
      failAutomationScan: true
    })
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe('unknown')
    const created = service.mutate({
      expectedRevision: 1,
      mutation: {
        kind: 'create',
        baseAgent: 'claude',
        draft: { label: 'New One', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(created.ok).toBe(true)
    expect(state.settings.deletedCustomTuiAgents).toHaveLength(1)
  })

  it('reference removal prunes the tombstone and advances both revisions', () => {
    const { service, state } = serviceWith({
      settings: baseSettings({
        terminalQuickCommands: [agentQuickCommand(deadId)],
        deletedCustomTuiAgents: [tombstoneFor(deadId)]
      })
    })
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: { kind: 'quick-command-delete', id: 'qc-1' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.referenceRevision).toBe(2)
    // Tombstone pruned in the follow-up catalog write with its own revision bump.
    expect(state.settings.deletedCustomTuiAgents).toHaveLength(0)
    expect(state.settings.agentCatalogRevision).toBe(2)
    expect(result.catalogRevision).toBe(2)
  })

  it('reference-removal prune strips a suppressed same-id live row instead of resurrecting it', () => {
    // Corrupted/legacy merge state: a full live definition survived deletion and
    // is suppressed only by the tombstone. The prune must not make it launchable.
    const zombie = liveAgent({ id: deadId, label: 'Zombie', args: '--secret' })
    const { service, state } = serviceWith({
      settings: baseSettings({
        customTuiAgents: [zombie],
        terminalQuickCommands: [agentQuickCommand(deadId)],
        deletedCustomTuiAgents: [tombstoneFor(deadId)]
      })
    })
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: { kind: 'quick-command-delete', id: 'qc-1' }
    })
    expect(result.ok).toBe(true)
    expect(state.settings.deletedCustomTuiAgents).toHaveLength(0)
    expect(state.settings.customTuiAgents).toEqual([])
  })
})

describe('session owner (host-private resume records)', () => {
  const recordStore = getHostAgentSessionRecordStore()
  const deadId = customId('codex', UUID_B)

  afterEach(() => {
    // The record store is a host-wide singleton; clear seeded records between tests.
    recordStore.rebuildRecordsFrom([])
    vi.restoreAllMocks()
  })

  function sessionRecord(requestedAgent: TuiAgent): HostSessionLaunchRecord {
    return {
      worktreeId: 'wt-session',
      requestedAgent,
      baseAgent: 'codex',
      providerSession: { key: 'session_id', id: 'sess-1' },
      registeredAt: 1,
      updatedAt: 1
    }
  }

  function serviceWithTombstone(): AgentCatalogService {
    const state: StoreStubState = {
      settings: baseSettings({ deletedCustomTuiAgents: [tombstoneFor(deadId)] }),
      repos: [],
      automations: []
    }
    return new AgentCatalogService(makeStoreStub(state))
  }

  it('retains the tombstone while a resumable session references the custom id and prunes after it is forgotten', () => {
    const service = serviceWithTombstone()

    recordStore.rebuildRecordsFrom([sessionRecord(deadId)])
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(1)
    expect(service.getReferenceSummaries(deadId)).toContainEqual({ owner: 'session', count: 1 })

    // Forgetting the last referencing session clears the reference so it can prune.
    recordStore.rebuildRecordsFrom([])
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(0)
  })

  it('retains the tombstone when the session record store cannot be read', () => {
    const service = serviceWithTombstone()
    vi.spyOn(recordStore, 'referencedRequestedAgents').mockImplementation(() => {
      throw new Error('store unavailable')
    })
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe('unknown')
  })
})

describe('background owner (host-private generic launch attempts)', () => {
  const attemptStore = getHostBackgroundAgentLaunchStore()
  const deadId = customId('codex', UUID_B)

  afterEach(() => {
    // Host-wide singleton; clear seeded attempts between tests.
    attemptStore.rebuildFrom([])
    vi.restoreAllMocks()
  })

  function serviceWithTombstone(): AgentCatalogService {
    const state: StoreStubState = {
      settings: baseSettings({ deletedCustomTuiAgents: [tombstoneFor(deadId)] }),
      repos: [],
      automations: []
    }
    return new AgentCatalogService(makeStoreStub(state))
  }

  it('retains the tombstone while a background attempt references the custom id and prunes after it is gone', () => {
    const service = serviceWithTombstone()

    attemptStore.create({
      attemptId: 'attempt-dead',
      worktreeId: 'wt-bg',
      operationId: 'op-1',
      requestedAgent: deadId,
      baseAgent: 'codex'
    })
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(1)
    expect(service.getReferenceSummaries(deadId)).toContainEqual({ owner: 'background', count: 1 })

    // Pruning the last referencing attempt clears the reference.
    attemptStore.rebuildFrom([])
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe(0)
  })

  it('retains the tombstone when the background attempt store cannot be read', () => {
    const service = serviceWithTombstone()
    vi.spyOn(attemptStore, 'referencedRequestedAgents').mockImplementation(() => {
      throw new Error('store unavailable')
    })
    expect(service.tombstoneReferenceIndex.countReferences(deadId)).toBe('unknown')
  })
})

describe('base-disable impact (§973)', () => {
  const recordStore = getHostAgentSessionRecordStore()
  const derivId = customId('claude', UUID_A)
  const otherBaseId = customId('codex', UUID_B)

  afterEach(() => {
    recordStore.rebuildRecordsFrom([])
    vi.restoreAllMocks()
  })

  function sessionRecord(
    baseAgent: 'claude' | 'codex',
    requestedAgent: TuiAgent,
    sessionId: string
  ): HostSessionLaunchRecord {
    return {
      worktreeId: 'wt-impact',
      requestedAgent,
      baseAgent,
      // Both claude and codex key on 'session_id' (only antigravity differs); the
      // key value is irrelevant here — countRecordsByBase reads baseAgent only.
      providerSession: { key: 'session_id', id: sessionId },
      registeredAt: 1,
      updatedAt: 1
    }
  }

  function impactService(state: Partial<StoreStubState> = {}): AgentCatalogService {
    const fullState: StoreStubState = {
      settings: baseSettings({
        defaultTuiAgent: 'claude',
        customTuiAgents: [
          liveAgent({ id: derivId, baseAgent: 'claude', label: 'Claude Deriv' }),
          liveAgent({ id: otherBaseId, baseAgent: 'codex', label: 'Codex Custom' })
        ],
        terminalQuickCommands: [
          agentQuickCommand(derivId),
          { id: 'qc-2', label: 'Q2', action: 'agent-prompt', agent: 'codex', prompt: 'p' }
        ]
      }),
      repos: [],
      automations: [],
      ...state
    }
    return new AgentCatalogService(makeStoreStub(fullState))
  }

  it('counts base-direct + derivative saved references (excluding sessions) and resumable sessions by base', () => {
    const service = impactService()
    // A claude session on the derivative is counted as a session, NOT double-counted
    // under savedReferences; a codex session on a different base is ignored for claude.
    recordStore.rebuildRecordsFrom([
      sessionRecord('claude', derivId, 'sess-claude'),
      sessionRecord('codex', otherBaseId, 'sess-codex')
    ])
    const impact = service.getBaseDisableImpact('claude')
    // default 'claude' (base-direct) + quick-command on the derivative = 2.
    expect(impact.savedReferences).toEqual({ count: 2, atLeast: false })
    expect(impact.resumableSessions).toEqual({ count: 1, atLeast: false })
  })

  it('reports atLeast on saved references when a reference owner store cannot be read', () => {
    const service = impactService({ failAutomationScan: true })
    const impact = service.getBaseDisableImpact('claude')
    // Readable owners (default + quick-command) still count; automation is unknown.
    expect(impact.savedReferences).toEqual({ count: 2, atLeast: true })
    expect(impact.resumableSessions.atLeast).toBe(false)
  })

  it('reports atLeast on resumable sessions when the record store cannot be read', () => {
    const service = impactService()
    vi.spyOn(recordStore, 'countRecordsByBase').mockImplementation(() => {
      throw new Error('store unavailable')
    })
    const impact = service.getBaseDisableImpact('claude')
    expect(impact.resumableSessions).toEqual({ count: 0, atLeast: true })
    expect(impact.savedReferences.atLeast).toBe(false)
  })

  it('returns zero impact for a base with no references or sessions', () => {
    const service = impactService()
    const impact = service.getBaseDisableImpact('gemini')
    expect(impact.savedReferences).toEqual({ count: 0, atLeast: false })
    expect(impact.resumableSessions).toEqual({ count: 0, atLeast: false })
  })
})

describe('delete -> tombstone -> reference lifecycle', () => {
  it('keeps the tombstone alive through delete while a quick command references it', () => {
    const live = liveAgent()
    const state: StoreStubState = {
      settings: baseSettings({
        customTuiAgents: [live],
        terminalQuickCommands: [agentQuickCommand(live.id)]
      }),
      repos: [],
      automations: []
    }
    const service = new AgentCatalogService(makeStoreStub(state))
    const deleted = service.mutate({
      expectedRevision: 1,
      mutation: { kind: 'delete-custom', id: live.id }
    })
    expect(deleted.ok).toBe(true)
    expect(state.settings.customTuiAgents).toHaveLength(0)
    expect(state.settings.deletedCustomTuiAgents?.[0]?.id).toBe(live.id)
    expect(service.tombstoneReferenceIndex.countReferences(live.id)).toBe(1)
    // The label stays reserved while referenced.
    const relabel = service.mutate({
      expectedRevision: state.settings.agentCatalogRevision ?? 1,
      mutation: {
        kind: 'create',
        baseAgent: 'codex',
        draft: { label: 'My Codex', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(relabel).toMatchObject({ ok: false, code: 'duplicate_agent_label' })
  })
})

describe('local draft endpoint', () => {
  it('returns exactly one row at the current revision and rejects stale locators', () => {
    const live = liveAgent({ env: { SECRET: 'value' } })
    const state: StoreStubState = {
      settings: baseSettings({ customTuiAgents: [live], agentCatalogRevision: 7 }),
      repos: [],
      automations: []
    }
    const service = new AgentCatalogService(makeStoreStub(state))
    const draft = service.getLocalDraft({ id: live.id }, 7)
    expect(draft).toMatchObject({
      status: 'ready',
      revision: 7,
      draft: { label: 'My Codex', env: { SECRET: 'value' } }
    })
    expect(service.getLocalDraft({ id: live.id }, 6)).toEqual({ status: 'stale' })
    expect(service.getLocalDraft({ id: customId('claude', UUID_B) }, 7)).toEqual({
      status: 'stale'
    })
  })

  it('never returns env values in the list snapshot while the draft carries them', () => {
    const live = liveAgent({ env: { SECRET: 'value' } })
    const state: StoreStubState = {
      settings: baseSettings({ customTuiAgents: [live] }),
      repos: [],
      automations: []
    }
    const service = new AgentCatalogService(makeStoreStub(state))
    const snapshotText = JSON.stringify(service.getLocalSnapshot())
    expect(snapshotText).not.toContain('SECRET')
    expect(snapshotText).not.toContain('value')
    const remoteText = JSON.stringify(service.getRemoteSnapshot())
    expect(remoteText).not.toContain('SECRET')
    expect(remoteText).not.toContain('value')
    // Env presence is summarized numerically only.
    const local = service.getLocalSnapshot()
    const row = local.customAgents[0]
    expect(row.status).toBe('ready')
    if (row.status === 'ready') {
      expect(row.envSummary.entryCount).toBe(1)
    }
  })
})
