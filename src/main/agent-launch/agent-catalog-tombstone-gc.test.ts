import { describe, expect, it } from 'vitest'
import type {
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings
} from '../../shared/types'
import type { CustomAgentDraft } from '../../shared/agent-catalog-snapshot'
import {
  AgentCatalogRepairTokenRegistry,
  applyAgentCatalogMutation,
  type ApplyAgentCatalogMutationArgs
} from './agent-catalog-mutations'

const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'
const UUID_B = 'fedcba98-7654-4321-8fed-cba987654321'

function customId(base: string, uuid = UUID_A): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

function liveAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
  return {
    id: customId('codex'),
    baseAgent: 'codex',
    label: 'My Codex',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

function draft(overrides: Partial<CustomAgentDraft> = {}): CustomAgentDraft {
  return {
    label: 'New Agent',
    commandOverride: null,
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

function settingsWith(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    defaultTuiAgent: 'auto',
    disabledTuiAgents: [],
    customTuiAgents: [],
    deletedCustomTuiAgents: [],
    agentCatalogRevision: 5,
    agentCmdOverrides: {},
    ...overrides
  } as GlobalSettings
}

function apply(
  overrides: Partial<ApplyAgentCatalogMutationArgs> & {
    mutation: ApplyAgentCatalogMutationArgs['request']['mutation']
  }
) {
  const { mutation, ...rest } = overrides
  return applyAgentCatalogMutation({
    settings: settingsWith(),
    currentRevision: 5,
    repairTokens: new AgentCatalogRepairTokenRegistry(),
    countTombstoneReferences: () => 0,
    ...rest,
    request: { expectedRevision: 5, mutation }
  })
}

describe('tombstone prune with a suppressed same-id persisted row', () => {
  const zombieId = customId('codex', UUID_B)
  const tombstone: DeletedCustomTuiAgent = {
    id: zombieId,
    baseAgent: 'codex',
    label: 'Gone',
    deletedAt: 1
  }

  it('strips the suppressed live row in the same write that prunes its tombstone', () => {
    // Corrupted/legacy merge state: a full live definition survived deletion and
    // is suppressed only by the tombstone. Pruning the tombstone alone would
    // resurrect it with the args/env deletion made unrecoverable.
    const zombie = liveAgent({ id: zombieId, label: 'Zombie', args: '--secret' })
    const result = apply({
      settings: settingsWith({
        customTuiAgents: [zombie],
        deletedCustomTuiAgents: [tombstone]
      }),
      countTombstoneReferences: () => 0,
      mutation: { kind: 'create', baseAgent: 'claude', draft: draft() }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.prunedTombstoneIds).toEqual([zombieId])
    expect(result.patch.deletedCustomTuiAgents).toEqual([])
    const live = result.patch.customTuiAgents ?? []
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe(result.mintedId)
  })

  it('strips the suppressed row on update-custom prunes too', () => {
    const zombie = liveAgent({ id: zombieId, label: 'Zombie' })
    const edited = liveAgent({ label: 'Edited Target' })
    const result = apply({
      settings: settingsWith({
        customTuiAgents: [zombie, edited],
        deletedCustomTuiAgents: [tombstone]
      }),
      countTombstoneReferences: () => 0,
      mutation: {
        kind: 'update-custom',
        id: edited.id,
        changes: { label: 'Renamed', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.prunedTombstoneIds).toEqual([zombieId])
    const live = result.patch.customTuiAgents ?? []
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: edited.id, label: 'Renamed' })
  })

  it('keeps a corrupt same-id row visible for repair instead of silently discarding it', () => {
    // Base mismatch makes the row corrupt, not suppressed: it stays visible for
    // explicit repair even when its same-id tombstone prunes.
    const corrupt = { ...liveAgent({ id: zombieId, label: 'Mismatch' }), baseAgent: 'claude' }
    const result = apply({
      settings: settingsWith({
        customTuiAgents: [corrupt as CustomTuiAgent],
        deletedCustomTuiAgents: [tombstone]
      }),
      countTombstoneReferences: () => 0,
      mutation: { kind: 'create', baseAgent: 'claude', draft: draft() }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const live = result.patch.customTuiAgents ?? []
    expect(live).toHaveLength(2)
    expect(live[0]).toMatchObject({ id: zombieId, label: 'Mismatch' })
  })

  it('retains the tombstone and the suppression while references are unknown', () => {
    const zombie = liveAgent({ id: zombieId, label: 'Zombie' })
    const result = apply({
      settings: settingsWith({
        customTuiAgents: [zombie],
        deletedCustomTuiAgents: [tombstone]
      }),
      countTombstoneReferences: () => 'unknown',
      mutation: { kind: 'create', baseAgent: 'claude', draft: draft() }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.prunedTombstoneIds).toEqual([])
    expect(result.patch.deletedCustomTuiAgents).toEqual([tombstone])
    // The suppressed row stays persisted (and suppressed) until a real prune.
    expect(result.patch.customTuiAgents).toHaveLength(2)
  })
})
