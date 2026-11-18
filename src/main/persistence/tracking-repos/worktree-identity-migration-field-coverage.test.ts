import { describe, expect, it } from 'vitest'
import {
  getDefaultPersistedState,
  getDefaultWorkspaceSession
} from '../../../shared/orca-profiles/constants'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'

import { migrateWorktreeIdentity } from './worktree-identity-migration'

const REPO = 'repo'
const OLD = `${REPO}::/old/path`
const NEW = `${REPO}::/new/path`

type SessionField = keyof WorkspaceSessionState

const REFERENCE_FIXTURES: Partial<Record<SessionField, Partial<WorkspaceSessionState>>> = {
  clientHostedBrowserPagesByWorktree: {
    clientHostedBrowserPagesByWorktree: {
      [OLD]: [
        {
          v: 1,
          browserPageId: 'chp',
          workspaceId: OLD,
          browserProfileId: 'profile',
          url: 'https://e.com',
          title: 'E',
          pairedDeviceId: 'device',
          savedAt: 1
        }
      ]
    }
  },
  closedTerminalTabTombstonesByTabId: {
    closedTerminalTabTombstonesByTabId: { 'tab-1': { closedAt: 5, worktreeId: OLD } }
  }
}

function persistedState(session: WorkspaceSessionState): PersistedState {
  return { ...getDefaultPersistedState('/home/test'), workspaceSession: session }
}

describe('migrateWorktreeIdentity worktree-reference coverage', () => {
  // Collector checks keys only; rehydration also requires each row's workspaceId to match.
  it('re-points the workspaceId inside each client-hosted browser page row', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      ...REFERENCE_FIXTURES.clientHostedBrowserPagesByWorktree
    }
    migrateWorktreeIdentity(persistedState(session), OLD, NEW)
    expect(session.clientHostedBrowserPagesByWorktree?.[NEW]?.[0]?.workspaceId).toBe(NEW)
  })

  it('migrates host partitions, not just the local blob', () => {
    const hostSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      ...REFERENCE_FIXTURES.closedTerminalTabTombstonesByTabId
    }
    const state = persistedState(getDefaultWorkspaceSession())
    state.workspaceSessionsByHostId = { 'ssh:target': hostSession }
    expect(migrateWorktreeIdentity(state, OLD, NEW)).toBe(true)
    expect(hostSession.closedTerminalTabTombstonesByTabId?.['tab-1']?.worktreeId).toBe(NEW)
  })

  it('re-keys a cross-store link by its child and never touches a parent in another store', () => {
    // A copied profile can name the same locator in the other store.
    const parent = {
      installationId: 'other-install',
      workspaceKey: 'worktree:repo::/old/path',
      instanceId: 'parent-instance'
    }
    const state = persistedState(getDefaultWorkspaceSession())
    state.crossStoreLineageByChildKey = {
      'worktree:repo::/old/path': { childWorkspaceKey: 'worktree:repo::/old/path', parent },
      'worktree:repo::/sibling': { childWorkspaceKey: 'worktree:repo::/sibling', parent }
    }

    expect(migrateWorktreeIdentity(state, OLD, NEW)).toBe(true)
    expect(state.crossStoreLineageByChildKey).toEqual({
      'worktree:repo::/new/path': {
        childWorkspaceKey: 'worktree:repo::/new/path',
        parent: {
          installationId: 'other-install',
          workspaceKey: 'worktree:repo::/old/path',
          instanceId: 'parent-instance'
        }
      },
      'worktree:repo::/sibling': {
        childWorkspaceKey: 'worktree:repo::/sibling',
        parent: {
          installationId: 'other-install',
          workspaceKey: 'worktree:repo::/old/path',
          instanceId: 'parent-instance'
        }
      }
    })
  })
})
