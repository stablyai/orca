import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { type ExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { PtyProcessInfo } from '../../../providers/pty/process-info'

export function registerTerminalListExecutionHostScopeTests(): void {
  // A scoped list must identify its hosts so omitting a live remote worker cannot be mistaken for exit.

  const LOCAL_WORKTREE_ID = 'repo-local::/tmp/local-worktree'

  const REPOS = [
    {
      id: 'repo-local',
      path: '/tmp/local-worktree',
      displayName: 'local',
      badgeColor: '#000000',
      addedAt: 0
    },
    {
      id: 'repo-ssh',
      path: '/remote/ssh-worktree',
      displayName: 'ssh',
      badgeColor: '#000000',
      addedAt: 0,
      connectionId: 'box-1'
    }
  ]

  function makeStore() {
    const session: WorkspaceSessionState = getDefaultWorkspaceSession()
    return {
      getWorkspaceSession: vi.fn(() => session),
      getWorkspaceSessionHostIds: vi.fn(() => ['local', 'ssh:box-1']),
      getFolderWorkspaces: vi.fn((): FolderWorkspace[] => []),
      getProjectGroups: vi.fn(() => []),
      setWorkspaceSession: vi.fn(),
      getRepos: vi.fn(() => REPOS),
      getRepo: vi.fn((id: string) => REPOS.find((repo) => repo.id === id)),
      getAllWorktreeMeta: vi.fn(() => ({})),
      getWorktreeMeta: vi.fn(() => undefined),
      setWorktreeMeta: vi.fn(),
      removeWorktreeMeta: vi.fn(),
      getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
      getProjects: vi.fn(() => [])
    }
  }

  type GraphLeaf = { worktreeId: string; leafId: string; ptyId: string }

  function makeRuntime(leaves: GraphLeaf[], store = makeStore()): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService(store as never)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => leaves.map((leaf) => ({ id: leaf.ptyId, cwd: '/tmp' })))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: leaves.map((leaf, index) => ({
        tabId: `tab-${index + 1}`,
        worktreeId: leaf.worktreeId,
        title: '',
        activeLeafId: leaf.leafId,
        layout: null
      })),
      leaves: leaves.map((leaf, index) => ({
        tabId: `tab-${index + 1}`,
        worktreeId: leaf.worktreeId,
        leafId: leaf.leafId,
        paneRuntimeId: index + 1,
        ptyId: leaf.ptyId,
        paneTitle: null,
        title: ''
      }))
    })
    return runtime
  }

  describe('listTerminals scope declaration', () => {
    // A targeted listing a newer census overtook joins that census instead of answering for no
    // host; re-listing would overtake the newer one in turn (two workspaces sleeping at once).
    it('answers from a newer concurrent inventory refresh instead of an empty scope', async () => {
      const runtime = makeRuntime([])
      const releases: (() => void)[] = []
      const listProcessesWithHostScope = vi.fn(
        () =>
          new Promise<{ processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }>((resolve) => {
            releases.push(() => resolve({ processes: [], hostIds: [LOCAL_EXECUTION_HOST_ID] }))
          })
      )
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: vi.fn(async () => []),
        listProcessesWithHostScope
      })

      const superseded = runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      const current = runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      releases[1]!()
      releases[0]!()

      expect((await superseded).hostScope?.hostIds).toEqual(['local'])
      expect((await current).hostScope?.hostIds).toEqual(['local'])
      expect(listProcessesWithHostScope).toHaveBeenCalledTimes(2)
    })
  })
}
