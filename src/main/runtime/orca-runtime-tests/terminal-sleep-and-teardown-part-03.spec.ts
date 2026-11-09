import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'
import '../hosts/platform-probe/runtime-machine-name'

describe('OrcaRuntimeService', () => {
  it('stops nothing for a sole-terminal sleep while another terminal in the worktree is live', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-run', cwd: TEST_WORKTREE_PATH, worktreeId: TEST_WORKTREE_ID, title: 'Claude' },
        { id: 'pty-user', cwd: TEST_WORKTREE_PATH, worktreeId: TEST_WORKTREE_ID, title: 'Shell' }
      ]
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, { soleLivePtyId: 'pty-run' })
    ).resolves.toEqual({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: ['pty-run', 'pty-user'],
      postStopVerified: true
    })
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('rejects exact terminal stop when async PTY stop fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual({ keepHistory: true })
        return false
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }]
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'], {
        keepHistory: true
      })
    ).rejects.toThrow('terminal_exact_stop_failed')
    expect(stopped).toEqual(['pty-1'])
  })

  it('rejects exact terminal stop when the live PTY set has extras', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' },
        { id: 'pty-shell', cwd: '/tmp/worktree-a', title: 'Shell' }
      ]
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        },
        {
          tabId: 'tab-2',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Shell',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        },
        {
          tabId: 'tab-2',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-shell'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'])
    ).rejects.toThrow('terminal_stop_pty_set_mismatch')
    expect(stopped).toEqual([])
  })

  it('allows target-only exact terminal stop when sibling PTYs remain live', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [
      [
        { id: 'pty-1', cwd: TEST_WORKTREE_PATH, worktreeId: TEST_WORKTREE_ID, title: 'Claude' },
        { id: 'pty-shell', cwd: TEST_WORKTREE_PATH, worktreeId: TEST_WORKTREE_ID, title: 'Shell' }
      ],
      [{ id: 'pty-shell', cwd: TEST_WORKTREE_PATH, worktreeId: TEST_WORKTREE_ID, title: 'Shell' }]
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual({ keepHistory: true })
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        },
        {
          tabId: 'tab-2',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        },
        {
          tabId: 'tab-2',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-shell'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, ['pty-1'], {
        keepHistory: true,
        targetOnly: true
      })
    ).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1', 'pty-shell'],
      postStopVerified: true,
      remainingLivePtyIds: ['pty-shell']
    })
    expect(stopped).toEqual(['pty-1'])
  })

  it('uses fresh post-stop liveness instead of stale renderer leaves', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        },
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'stale-pty'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'])
    ).resolves.toMatchObject({
      stoppedPtyIds: ['pty-1']
    })
    expect(stopped).toEqual(['pty-1'])
  })

  it('fails terminal listing closed when fresh PTY liveness is required and unavailable', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        throw new Error('provider unavailable')
      }
    })

    await expect(
      runtime.listTerminals('id:repo-1::/tmp/worktree-a', undefined, {
        requireFreshPtyLiveness: true
      })
    ).rejects.toThrow('terminal_liveness_unavailable')
  })
})
