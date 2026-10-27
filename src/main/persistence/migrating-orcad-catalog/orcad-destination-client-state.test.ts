import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultUIState } from '../../../shared/constants'
import type { OrcadMigrationClientStatePayload } from '../../../shared/orcad-migration/orcad-migration-client-state'
import {
  applyPreparedOrcadMigrationClientState,
  prepareOrcadMigrationClientState
} from './orcad-destination-client-state'

function state(): PersistedState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a minimal persisted state; the code under test reads only the client-state fields set here.
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
      filterRepoIds: [],
      showDotfilesByWorktree: { 'repo-1::/worktree': false }
    })
  })

  it("keeps a device's selections for workspaces outside the import", () => {
    const destination = state()
    const kept = { activeTabId: 'kept', activeGroupId: null, activeTabIdByGroupId: {} }
    destination.mobileClientTabSelectionsByDeviceId = { phone: { 'old::/workspace': kept } }
    applyPreparedOrcadMigrationClientState(
      prepareOrcadMigrationClientState(incoming, destination),
      destination
    )
    expect(destination.mobileClientTabSelectionsByDeviceId?.phone).toEqual({
      'old::/workspace': kept,
      ...incoming.mobileClientTabSelectionsByDeviceId?.phone
    })
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

  it("moves onto a fresh server whose sidebar shows all hosts, keeping the server's filters", () => {
    const destination = state()
    destination.ui = getDefaultUIState()
    const prepared = prepareOrcadMigrationClientState(
      {
        uiRouting: {
          workspaceHostScope: 'local',
          visibleWorkspaceHostIds: ['local'],
          workspaceHostOrder: ['local'],
          automationHostFilter: { kind: 'host', hostKey: 'host:runtime:environment-1:self' }
        }
      },
      destination
    )
    applyPreparedOrcadMigrationClientState(prepared, destination)
    expect(destination.ui).toMatchObject({
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: null,
      workspaceHostOrder: [],
      automationHostFilter: { kind: 'all' }
    })
  })

  it("keeps the server's own view preferences instead of refusing the move", () => {
    const destination = state()
    destination.ui = {
      ...destination.ui,
      lastActiveRepoId: 'server-repo',
      lastActiveWorktreeId: 'server-repo::/w',
      filterRepoIds: ['server-repo'],
      showDotfilesByWorktree: { 'server-repo::/w': true, 'repo-1::/worktree': true },
      setupScriptPromptDismissedRepoIds: ['server-repo'],
      manualRepoOrder: [{ hostId: 'local', repoId: 'server-repo' }],
      workspaceHostScope: 'all',
      acknowledgedAgentsByPaneKey: { 'server-tab:leaf': 5, 'tab-1:leaf': 9 }
    }
    const prepared = prepareOrcadMigrationClientState(
      {
        uiRouting: {
          ...incoming.uiRouting,
          setupScriptPromptDismissedRepoIds: ['repo-1'],
          acknowledgedAgentsByPaneKey: { 'tab-1:leaf': 1, 'tab-2:leaf': 2 }
        }
      },
      destination
    )
    applyPreparedOrcadMigrationClientState(prepared, destination)
    expect(destination.ui).toMatchObject({
      lastActiveRepoId: 'server-repo',
      lastActiveWorktreeId: 'server-repo::/w',
      filterRepoIds: ['server-repo'],
      showDotfilesByWorktree: { 'server-repo::/w': true, 'repo-1::/worktree': true },
      setupScriptPromptDismissedRepoIds: ['server-repo', 'repo-1'],
      manualRepoOrder: [{ hostId: 'local', repoId: 'server-repo' }],
      acknowledgedAgentsByPaneKey: { 'server-tab:leaf': 5, 'tab-1:leaf': 9, 'tab-2:leaf': 2 }
    })
  })

  it("ignores an older desktop's host filters on a server already scoped elsewhere", () => {
    const destination = state()
    destination.ui = {
      ...getDefaultUIState(),
      workspaceHostScope: 'runtime:other',
      visibleWorkspaceHostIds: ['runtime:other'],
      workspaceHostOrder: ['runtime:other'],
      automationHostFilter: { kind: 'host', hostKey: 'host:desktop:self' },
      filterRepoIds: ['server-repo'],
      acknowledgedAgentsByPaneKey: { 'tab-1:leaf': 1 }
    }
    const before = structuredClone(destination.ui)
    applyPreparedOrcadMigrationClientState(
      prepareOrcadMigrationClientState(
        {
          uiRouting: {
            workspaceHostScope: 'local',
            visibleWorkspaceHostIds: ['local'],
            workspaceHostOrder: ['local'],
            automationHostFilter: { kind: 'host', hostKey: 'host:runtime:environment-1:self' },
            filterRepoIds: ['repo-1'],
            acknowledgedAgentsByPaneKey: { 'tab-1:leaf': 7 }
          }
        },
        destination
      ),
      destination
    )
    expect(destination.ui).toEqual({ ...before, acknowledgedAgentsByPaneKey: { 'tab-1:leaf': 7 } })
  })
})
