import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { MOCK_GIT_WORKTREES } from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import 'node:path'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import 'node:os'

import { TEST_REPO_ID, deferred, store, withPlatform } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('tui-idle times out when PTY data has no agent OSC title transitions', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
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
      runtime.onPtyData('pty-1', 'running migration step 4/9\n', 123)

      const [terminal] = (await runtime.listTerminals()).terminals
      const waitPromise = runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(12_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('tui-idle resolves on agent working→idle OSC title transition', async () => {
    const runtime = new OrcaRuntimeService(store)

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

    runtime.onPtyData('pty-1', '\x1b]0;\u280b Working on task\x07output\n', 100)

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })

    runtime.onPtyData('pty-1', '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const result = await waitPromise
    expect(result.condition).toBe('tui-idle')
    expect(result.satisfied).toBe(true)
  })

  it('keeps each worktree poll paired with its platform generation', async () => {
    await withPlatform('win32', async () => {
      let runtimePreference: { kind: 'wsl'; distro: string } | { kind: 'windows-host' } = {
        kind: 'wsl',
        distro: 'Ubuntu'
      }
      const runtimeStore = {
        ...store,
        getProjects: () => [
          {
            id: 'project-generation',
            displayName: 'generation',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: runtimePreference,
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          localWindowsRuntimeDefault: { kind: 'windows-host' as const }
        })
      }
      const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
      const scansBefore = vi.mocked(listWorktrees).mock.calls.length
      vi.mocked(listWorktrees).mockImplementationOnce(() => staleScan.promise)
      const runtime = new OrcaRuntimeService(runtimeStore as never)

      const stalePoll = runtime.getWorktreePs()
      runtimePreference = { kind: 'windows-host' }
      runtime.notifyBranchRenamed(TEST_REPO_ID)
      const freshPolling = runtime.getWorktreePs()
      staleScan.resolve(MOCK_GIT_WORKTREES)
      const [staleResult, freshPoll] = await Promise.all([stalePoll, freshPolling])
      // Only the live route lists; the poll admitted for the replaced WSL route runs no Git.
      expect(vi.mocked(listWorktrees).mock.calls.length - scansBefore).toBe(1)

      // Concurrent scans retain the platform map from their own generation even when they finish out of order.
      expect(staleResult.worktrees[0]).toMatchObject({ terminalPlatform: 'linux' })
      expect(freshPoll.worktrees[0]).toMatchObject({ terminalPlatform: 'win32' })
    })
  })
})
