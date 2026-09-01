// Shared store stub and catalog fixtures for the AgentCatalogService suites.

import type {
  CustomTuiAgent,
  CustomTuiAgentId,
  GlobalSettings,
  Repo,
  TerminalAgentQuickCommand,
  WorktreeMeta
} from '../../shared/types'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { Store } from '../persistence'

export const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'
export const UUID_B = 'fedcba98-7654-4321-8fed-cba987654321'

export function customId(base: string, uuid = UUID_A): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

export function liveAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
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

export type StoreStubState = {
  settings: GlobalSettings
  repos: Repo[]
  automations: Automation[]
  automationRuns?: AutomationRun[]
  worktreeMeta?: Record<string, WorktreeMeta>
  failAutomationScan?: boolean
  failWorktreeScan?: boolean
  agentCatalogMigrationError?: string | null
  agentCatalogSchemaTooNew?: { persistedVersion: number; supportedVersion: number } | null
  failDurableWrite?: boolean
  // Stands in for persistence-side normalization/derivation of a patch.
  expandOnPersist?: (updates: Partial<GlobalSettings>) => Partial<GlobalSettings>
}

export function makeStoreStub(state: StoreStubState): Store {
  const preview = (updates: Partial<GlobalSettings>): GlobalSettings => ({
    ...state.settings,
    ...updates,
    ...state.expandOnPersist?.(updates)
  })
  const stub = {
    getSettings: () => state.settings,
    getAgentCatalogMigrationError: () => state.agentCatalogMigrationError ?? null,
    getAgentCatalogSchemaTooNew: () => state.agentCatalogSchemaTooNew ?? null,
    previewSettingsUpdate: preview,
    updateSettingsDurable: (updates: Partial<GlobalSettings>) => {
      if (state.failDurableWrite) {
        throw new Error('disk failure')
      }
      state.settings = preview(updates)
      return state.settings
    },
    updateSettings: (updates: Partial<GlobalSettings>) => {
      state.settings = preview(updates)
      return state.settings
    },
    getRepos: () => state.repos,
    listAutomations: () => {
      if (state.failAutomationScan) {
        throw new Error('store unavailable')
      }
      return state.automations
    },
    listAutomationRuns: () => state.automationRuns ?? [],
    getAllWorktreeMeta: () => {
      if (state.failWorktreeScan) {
        throw new Error('store unavailable')
      }
      return state.worktreeMeta ?? {}
    }
  }
  return stub as unknown as Store
}

export function baseSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
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

export function tombstoneFor(id: CustomTuiAgentId) {
  return { id, baseAgent: 'codex' as const, label: 'Gone', deletedAt: 1 }
}

export function agentQuickCommand(agent: CustomTuiAgentId): TerminalAgentQuickCommand {
  return { id: 'qc-1', label: 'Q', action: 'agent-prompt', agent, prompt: 'p' }
}
