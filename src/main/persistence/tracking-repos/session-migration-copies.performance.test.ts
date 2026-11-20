import { expect, it } from 'vitest'
import {
  getDefaultPersistedState,
  getDefaultWorkspaceSession
} from '../../../shared/orca-profiles/constants'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { migrateWorktreeIdentity } from './worktree-identity-migration'

// Perf contract (#44641): worktree moves publish replacement sessions; the host partition map must be
// copied once per move, not once per host (fails at 10 and 100 with the per-host copies).

const OLD = 'repo::/old/path'
const NEW = 'repo::/new/path'

function sessionWithTabs(worktreeId: string, ptyId: string | null): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: `tab-${worktreeId}`,
          ptyId,
          worktreeId,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
}

function hostMapCopiesForWorktreeMove(hosts: number): number {
  const state = getDefaultPersistedState('/home/test')
  let partitions: PersistedState['workspaceSessionsByHostId'] = {}
  for (let index = 0; index < hosts; index++) {
    partitions[`ssh:target-${index}`] = sessionWithTabs(OLD, null)
  }
  // Each publish of a new host map is one whole-map copy.
  let copies = 0
  Object.defineProperty(state, 'workspaceSessionsByHostId', {
    get: () => partitions,
    set: (next: PersistedState['workspaceSessionsByHostId']) => {
      copies += 1
      partitions = next
    }
  })
  expect(migrateWorktreeIdentity(state, OLD, NEW)).toBe(true)
  expect(Object.keys(partitions ?? {})).toHaveLength(hosts)
  for (const session of Object.values(partitions ?? {})) {
    expect(Object.keys(session?.tabsByWorktree ?? {})).toEqual([NEW])
  }
  return copies
}

it('copies the host partition map once per worktree move at N and 10N hosts', () => {
  expect(hostMapCopiesForWorktreeMove(10)).toBe(1)
  expect(hostMapCopiesForWorktreeMove(100)).toBe(1)
})
