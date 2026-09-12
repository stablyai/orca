import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  registerSshGitProvider,
  setPlatform,
  worktreePathComparison
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import { makeWorktreeMeta, store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps pinned and unread worktrees when active rows fill the mobile summary limit', async () => {
    setPlatform('win32')
    const remoteRepo = {
      id: 'repo-pinned-limit',
      path: '/remote',
      displayName: 'pinned-limit-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-pinned-limit'
    }
    const activeWorktrees = Array.from({ length: 199 }, (_, index) => ({
      path: `relative/active-${String(index).padStart(3, '0')}`,
      head: `head-${index}`,
      branch: `refs/heads/active-${index}`,
      isBare: false,
      isMainWorktree: false
    }))
    const pinnedPath = 'relative/zzz-pinned'
    const pinnedWorktree = {
      path: pinnedPath,
      head: 'pinned',
      branch: 'refs/heads/pinned',
      isBare: false,
      isMainWorktree: false
    }
    const unreadPath = 'relative/zzz-unread'
    const unreadWorktree = {
      ...pinnedWorktree,
      path: unreadPath,
      head: 'unread',
      branch: 'refs/heads/unread'
    }
    const pinnedId = `${remoteRepo.id}::${pinnedPath}`
    const unreadId = `${remoteRepo.id}::${unreadPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [pinnedId]: makeWorktreeMeta({ isPinned: true }),
      [unreadId]: makeWorktreeMeta({ isUnread: true })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    }
    registerSshGitProvider('ssh-pinned-limit', {
      listWorktrees: vi.fn().mockResolvedValue([...activeWorktrees, pinnedWorktree, unreadWorktree])
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        activeWorktrees.map((worktree, index) => ({
          paneKey: `active-tab:${String(index).padStart(8, '0')}-8888-4888-8888-888888888888`,
          worktreeId: `${remoteRepo.id}::${worktree.path.replace('relative/', 'relative/./')}`,
          tabId: 'active-tab',
          state: 'working' as const,
          prompt: 'active row',
          agentType: 'codex',
          connectionId: 'ssh-pinned-limit',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })

    const summaries = await runtime.getWorktreePs()

    expect(summaries).toMatchObject({ totalCount: 201, truncated: true })
    expect(summaries.worktrees).toHaveLength(200)
    expect(summaries.worktrees.find((worktree) => worktree.worktreeId === pinnedId)).toMatchObject({
      isPinned: true,
      hasHostSidebarActivity: false
    })
    expect(summaries.worktrees.find((worktree) => worktree.worktreeId === unreadId)).toMatchObject({
      unread: true,
      hasHostSidebarActivity: false
    })
    expect(
      worktreePathComparison.worktreePathComparisonKey(activeWorktrees[0]!.path, 'linux')
    ).toBe(
      worktreePathComparison.worktreePathComparisonKey(
        activeWorktrees[0]!.path.replace('relative/', 'relative/./'),
        'linux'
      )
    )
  })

  it('clears stale working status after the agent exits and the shell takes over the title', async () => {
    // Why (#1437): sticky lastAgentStatus left the spinner on 'working' after agent exit; recompute from the live OSC title each call.
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex working',
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

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const working = await runtime.getWorktreePs()
    expect(working.worktrees[0].status).toBe('working')

    // Agent exits, shell title takes over — mobile must flip to 'active' like desktop's getWorktreeStatus.
    runtime.onPtyData('pty-1', '\x1b]0;bash\x07', 200)
    const afterExit = await runtime.getWorktreePs()
    expect(afterExit.worktrees[0].status).toBe('active')
  })

  it('shows worktree.ps active when the current pane is the Claude agents screen', async () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })

    const summary = await runtime.getWorktreePs()

    expect(summary.worktrees[0].status).toBe('active')
  })
})
