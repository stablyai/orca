import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { OrcadMigrationClientStatePayload } from '../../../shared/orcad-migration-client-state'
import {
  applyPreparedOrcadMigrationClientState,
  assertCommittedOrcadMigrationClientState,
  prepareOrcadMigrationClientState
} from './orcad-destination-client-state'

function state(): PersistedState {
  return {
    ui: {
      lastActiveRepoId: null,
      lastActiveWorktreeId: null,
      filterRepoIds: [],
      showDotfilesByWorktree: {},
      setupScriptPromptDismissedRepoIds: [],
      manualRepoOrder: [],
      workspaceHostScope: undefined,
      visibleWorkspaceHostIds: null,
      workspaceHostOrder: [],
      automationHostFilter: { kind: 'all' },
      acknowledgedAgentsByPaneKey: {}
    }
  } as unknown as PersistedState
}

const incoming: OrcadMigrationClientStatePayload = {
  mobileClientTabSelectionsByDeviceId: {
    phone: {
      'repo-1::/worktree': {
        activeTabId: 'tab-1',
        activeGroupId: null,
        activeTabIdByGroupId: {}
      }
    }
  },
  uiRouting: {
    lastActiveRepoId: 'repo-1',
    lastActiveWorktreeId: 'repo-1::/worktree',
    filterRepoIds: ['repo-1'],
    showDotfilesByWorktree: { 'repo-1::/worktree': false },
    manualRepoOrder: [{ hostId: 'local', repoId: 'repo-1' }]
  }
}

describe('destination client-state migration', () => {
  it('applies selections and routing while preserving unrelated device state', () => {
    const destination = state()
    destination.mobileClientTabSelectionsByDeviceId = {
      tablet: {
        'repo-other::/worktree': {
          activeTabId: null,
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      }
    }
    const prepared = prepareOrcadMigrationClientState(incoming, destination)
    applyPreparedOrcadMigrationClientState(prepared, destination)

    expect(destination.mobileClientTabSelectionsByDeviceId).toMatchObject({
      phone: incoming.mobileClientTabSelectionsByDeviceId?.phone,
      tablet: expect.any(Object)
    })
    expect(destination.ui).toMatchObject({
      lastActiveRepoId: 'repo-1',
      lastActiveWorktreeId: 'repo-1::/worktree',
      filterRepoIds: ['repo-1'],
      showDotfilesByWorktree: { 'repo-1::/worktree': false }
    })
    expect(() => assertCommittedOrcadMigrationClientState(incoming, destination)).not.toThrow()
  })

  it('rejects a conflicting destination selection before publication', () => {
    const destination = state()
    destination.mobileClientTabSelectionsByDeviceId = {
      phone: {
        'repo-1::/worktree': {
          activeTabId: 'different-tab',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      }
    }
    expect(() => prepareOrcadMigrationClientState(incoming, destination)).toThrow(
      'orcad_migration_client_state_conflict:mobile'
    )
  })

  it('rejects non-default UI routing conflicts', () => {
    const destination = state()
    destination.ui.lastActiveRepoId = 'other-repo'
    expect(() => prepareOrcadMigrationClientState(incoming, destination)).toThrow(
      'orcad_migration_client_state_conflict:ui:last-active-repo'
    )
  })
})
