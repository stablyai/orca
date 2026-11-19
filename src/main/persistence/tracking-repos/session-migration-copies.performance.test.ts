import { expect, it } from 'vitest'
import {
  getDefaultPersistedState,
  getDefaultWorkspaceSession
} from '../../../shared/orca-profiles/constants'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { toAppSshPtyId } from '../../../shared/remote-runtime/ssh/ssh-pty-id'
import { migrateWorkspaceSessionSshTargetId } from '../../ssh/targets/ssh-target-id-migration'
import { migrateWorktreeIdentity } from './worktree-identity-migration'

// Perf contract: session migrations publish replacement sessions, so their copies must stay bounded
// by what changed, not by how many hosts or workspaces are saved.

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

function tabArraysBuiltForAbsentSshTarget(worktrees: number): number {
  let built = 0
  const tabsByWorktree: WorkspaceSessionState['tabsByWorktree'] = {}
  for (let index = 0; index < worktrees; index++) {
    const worktreeId = `repo::/w${index}`
    const tabs = sessionWithTabs(worktreeId, toAppSshPtyId('other-target', `pty-${index}`))
      .tabsByWorktree[worktreeId]!
    // Array#map reads `constructor` to build its result; plain iteration does not.
    tabsByWorktree[worktreeId] = new Proxy(tabs, {
      get(target, key, receiver) {
        if (key === 'constructor') {
          built += 1
        }
        return Reflect.get(target, key, receiver)
      }
    })
  }
  const session = { ...getDefaultWorkspaceSession(), tabsByWorktree }
  expect(migrateWorkspaceSessionSshTargetId(session, 'old-target', 'new-target')).toBeNull()
  return built
}

it('copies the host partition map once per worktree move at N and 10N hosts', () => {
  expect(hostMapCopiesForWorktreeMove(10)).toBe(1)
  expect(hostMapCopiesForWorktreeMove(100)).toBe(1)
})

it('builds no tab arrays when no saved tab names the re-adopted SSH target at N and 10N', () => {
  expect(tabArraysBuiltForAbsentSshTarget(200)).toBe(0)
  expect(tabArraysBuiltForAbsentSshTarget(2_000)).toBe(0)
})
