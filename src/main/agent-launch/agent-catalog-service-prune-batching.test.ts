// P1-9: the service's prune must index the owners ONCE per prune. A per-id
// counter re-scans every owner store per tombstone, which is quadratic on real
// catalogs, so these tests count owner scans rather than prune outcomes.

import { describe, expect, it } from 'vitest'
import type {
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings,
  TerminalAgentQuickCommand
} from '../../shared/types'
import type { Store } from '../persistence'
import { AgentCatalogService } from './agent-catalog-service'

const UUID_TAIL = '-89ab-4cde-8f01-23456789abcd'
const TOMBSTONE_COUNT = 25

function customId(index: number): CustomTuiAgentId {
  return `custom-agent:codex:${`${index}`.padStart(8, '0')}${UUID_TAIL}` as CustomTuiAgentId
}

function unreferencedTombstones(count: number): DeletedCustomTuiAgent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: customId(index),
    baseAgent: 'codex' as const,
    label: `Gone ${index}`,
    deletedAt: index
  }))
}

type ScanCounts = { worktreeMeta: number; automations: number }

function makeCountingStore(settings: GlobalSettings): { store: Store; scans: ScanCounts } {
  const state = { settings }
  const scans: ScanCounts = { worktreeMeta: 0, automations: 0 }
  const preview = (updates: Partial<GlobalSettings>): GlobalSettings => ({
    ...state.settings,
    ...updates
  })
  const stub = {
    getSettings: () => state.settings,
    getAgentCatalogMigrationError: () => null,
    getAgentCatalogSchemaTooNew: () => null,
    previewSettingsUpdate: preview,
    updateSettingsDurable: (updates: Partial<GlobalSettings>) => {
      state.settings = preview(updates)
      return state.settings
    },
    updateSettings: (updates: Partial<GlobalSettings>) => {
      state.settings = preview(updates)
      return state.settings
    },
    getRepos: () => [],
    listAutomations: () => {
      scans.automations += 1
      return []
    },
    listAutomationRuns: () => [],
    getAllWorktreeMeta: () => {
      scans.worktreeMeta += 1
      return {}
    }
  }
  return { store: stub as unknown as Store, scans }
}

function baseSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    defaultTuiAgent: 'auto',
    disabledTuiAgents: [],
    customTuiAgents: [],
    deletedCustomTuiAgents: [],
    agentCatalogRevision: 1,
    agentReferenceRevision: 1,
    terminalQuickCommands: [],
    agentCmdOverrides: {},
    ...overrides
  } as GlobalSettings
}

function agentQuickCommand(agent: CustomTuiAgentId): TerminalAgentQuickCommand {
  return { id: 'qc-1', label: 'Q', action: 'agent-prompt', agent, prompt: 'p' }
}

describe('agent catalog service tombstone prune batching (P1-9)', () => {
  it('scans each owner once for a mutation prune, not once per tombstone', () => {
    const { store, scans } = makeCountingStore(
      baseSettings({ deletedCustomTuiAgents: unreferencedTombstones(TOMBSTONE_COUNT) })
    )
    const service = new AgentCatalogService(store)

    const created = service.mutate({
      expectedRevision: 1,
      mutation: {
        kind: 'create',
        baseAgent: 'claude',
        draft: { label: 'New One', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })

    expect(created.ok).toBe(true)
    expect(store.getSettings().deletedCustomTuiAgents).toHaveLength(0)
    expect(scans).toEqual({ worktreeMeta: 1, automations: 1 })
  })

  it('scans each owner once for the post-reference-removal prune', () => {
    const { store, scans } = makeCountingStore(
      baseSettings({
        terminalQuickCommands: [agentQuickCommand(customId(0))],
        deletedCustomTuiAgents: unreferencedTombstones(TOMBSTONE_COUNT)
      })
    )
    const service = new AgentCatalogService(store)

    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: { kind: 'quick-command-delete', id: 'qc-1' }
    })

    expect(result.ok).toBe(true)
    expect(store.getSettings().deletedCustomTuiAgents).toHaveLength(0)
    expect(scans).toEqual({ worktreeMeta: 1, automations: 1 })
  })
})
