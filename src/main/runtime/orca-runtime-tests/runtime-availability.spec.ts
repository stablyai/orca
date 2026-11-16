import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import '../../../shared/constants'
import { OrcaRuntimeService } from '../orca-runtime'
import { scanLocalRepoWorktreesForResolutionMock } from '../orca-runtime-test-mocks/setup.spec'
import {
  HEADLESS_LEAF_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeWorktreeScanResult } from '../workspaces/catalog/repo-worktree-resolution-scan'

describe('OrcaRuntimeService', () => {
  it('does not block a targeted mobile session tab list on an unrelated worktree scan', async () => {
    const remoteWorktreeId = 'repo-ssh::/remote/worktree'
    const remotePtyId = 'ssh:ssh-target@@remote-pty'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeRepoId: 'repo-ssh',
        activeWorktreeId: remoteWorktreeId,
        activeTabIdByWorktree: { [remoteWorktreeId]: 'remote-tab' },
        tabsByWorktree: {
          [remoteWorktreeId]: [
            {
              id: 'remote-tab',
              ptyId: remotePtyId,
              worktreeId: remoteWorktreeId,
              title: 'Remote terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'remote-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: remotePtyId })
        }
      }),
      'ssh:ssh-target'
    )
    const remoteRepo = {
      ...store.getRepos()[0],
      id: 'repo-ssh',
      connectionId: 'ssh-target'
    }
    const localRepo = store.getRepos()[0]
    const repos = [remoteRepo, localRepo]
    runtimeStore.getRepos = () => repos
    runtimeStore.getRepo = (id: string) => repos.find((repo) => repo.id === id)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const listProcesses = vi.fn(async () => [
      {
        id: remotePtyId,
        incarnationId: 'remote-incarnation',
        terminalHandle: 'term_remote',
        title: 'Remote terminal',
        cwd: '/remote/worktree',
        worktreeId: remoteWorktreeId
      }
    ])
    runtime.setPtyController({
      listProcesses,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const scan = Promise.withResolvers<RuntimeWorktreeScanResult>()
    scanLocalRepoWorktreesForResolutionMock.mockImplementation(() => scan.promise)

    vi.useFakeTimers()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const resultPromise = runtime.listMobileSessionTabs(`id:${remoteWorktreeId}`)
    try {
      const timeout = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), 1_000)
      })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await Promise.race([resultPromise, timeout])
      expect(result).not.toBeNull()
      expect(scanLocalRepoWorktreesForResolutionMock).not.toHaveBeenCalled()
      expect(listProcesses).toHaveBeenCalledOnce()
      expect(listProcesses).toHaveBeenCalledWith(
        'ssh:ssh-target',
        expect.objectContaining({ deadlineMs: expect.any(Number) })
      )
      expect(result).toMatchObject({
        worktree: remoteWorktreeId,
        tabs: [expect.objectContaining({ type: 'terminal', parentTabId: 'remote-tab' })]
      })
    } finally {
      scan.resolve({ ok: false, worktrees: [] })
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      try {
        await resultPromise
      } finally {
        vi.useRealTimers()
      }
    }
  })
})
