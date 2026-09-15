import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeStore } from './runtime-store-contract'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'

function harness(hosts: ExecutionHostId[], folder = false) {
  const worktreeId = folder ? 'folder:one' : 'repo::/project'
  const foreign = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [worktreeId]: [{ id: 'foreign', worktreeId }] }
  }
  const empty = getDefaultWorkspaceSession()
  const setWorkspaceSession = vi.fn()
  const store = {
    getRepos: () =>
      folder ? [] : hosts.map((executionHostId) => ({ id: 'repo', executionHostId })),
    getFolderWorkspaces: () => (folder ? [{ id: 'one', executionHostId: hosts[0] }] : []),
    getWorkspaceSessionHostIds: () => ['local', 'runtime:other', ...hosts],
    getWorkspaceSession: (hostId: string) => (hostId === 'runtime:other' ? foreign : empty),
    setWorkspaceSession
  } as unknown as RuntimeStore
  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: () => null,
    hasRuntimeOwnedPtyCandidate: () => true
  })
  return { controller, worktreeId, foreign, empty, setWorkspaceSession }
}

describe('workspace session partition authority', () => {
  it.each([false, true])(
    'does not adopt a foreign partition when the owner is empty (folder=%s)',
    (folder) => {
      const h = harness(['runtime:owner'], folder)
      expect(h.controller.tryGetHostId(h.worktreeId)).toBe('runtime:owner')
      expect(h.controller.get(h.worktreeId)).toBe(h.empty)
      expect(h.controller.getHydrationTargets(true).has(h.worktreeId)).toBe(false)
      h.controller.set(h.worktreeId, h.empty)
      expect(h.setWorkspaceSession).toHaveBeenCalledWith(h.empty, 'runtime:owner')
    }
  )

  it.each([
    ['local', 'runtime:owner'],
    ['ssh:first', 'ssh:second'],
    ['runtime:first', 'runtime:second']
  ] as ExecutionHostId[][])('refuses colliding repository owners %s and %s', (first, second) => {
    const h = harness([first!, second!])
    expect(() => h.controller.tryGetHostId(h.worktreeId)).toThrow(
      'worktree_execution_host_unresolved'
    )
    expect(() => h.controller.get(h.worktreeId)).toThrow('worktree_execution_host_unresolved')
    expect(h.controller.getHydrationTargets(true).size).toBe(0)
    expect(() => h.controller.set(h.worktreeId, h.empty)).toThrow(
      'worktree_execution_host_unresolved'
    )
    expect(h.setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('accepts duplicate repository rows that agree on their host', () => {
    const h = harness(['ssh:owner', 'ssh:owner'])
    expect(h.controller.tryGetHostId(h.worktreeId)).toBe('ssh:owner')
  })
})
