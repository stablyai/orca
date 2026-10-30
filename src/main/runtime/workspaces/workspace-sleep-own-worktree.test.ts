import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type { WorkspaceSleepNotice } from '../../../shared/workspace-sleep'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    sleepWorkspace: async () => ({ stoppedSessionIds: [] })
  })
}))
import { WorkspaceSleepCoordinator, type WorkspaceSleepRuntime } from './workspace-sleep-runtime'

const WORKTREE = 'repo::/w'
const verified: RuntimeWorktreeTerminalSleepResult = {
  stopped: 1,
  stoppedPtyIds: ['pty-1'],
  livePtyIds: ['pty-1'],
  postStopVerified: true
}

function coordinator(overrides: Partial<WorkspaceSleepRuntime> = {}) {
  const notices: WorkspaceSleepNotice[] = []
  const runtime: WorkspaceSleepRuntime = {
    workspaceLifecycle: new WorkspaceLifecycleQueue(),
    workspaceSleepPlatform: null,
    listRepos: () => [],
    showManagedWorktree: async () => ({ id: WORKTREE, repoId: 'repo' }),
    listTerminals: async () => ({ terminals: [] }),
    sleepTerminalsForWorktree: async () => verified,
    ensureStructuredAgentSessionHost: async () => {},
    notifyWorkspaceSleep: (notice) => notices.push(notice),
    wakeRecordsForWorktree: () => [],
    resumeSleptWorkspaceAgents: async () => {},
    ensureRestoredPaneStarted: async () => null,
    wakeWindowHibernatedAgents: () => {},
    ...overrides
  }
  return { sleep: new WorkspaceSleepCoordinator(runtime), notices }
}

const failedNotices = (notices: WorkspaceSleepNotice[]) =>
  notices.filter((notice) => notice.phase === 'failed')

describe("a phone's or the CLI's sleep", () => {
  it('tells the window to show the toast when the terminals could not be stopped', async () => {
    const { sleep, notices } = coordinator({
      sleepTerminalsForWorktree: async () => {
        throw new Error('terminal_worktree_sleep_still_live')
      }
    })
    await sleep.sleepOwnWorktree(WORKTREE, { replyOnAcceptance: true })
    await vi.waitFor(() =>
      expect(failedNotices(notices)).toEqual([
        {
          worktreeId: WORKTREE,
          phase: 'failed',
          outcome: expect.objectContaining({ failure: 'terminal_worktree_sleep_still_live' })
        }
      ])
    )
  })

  it('tells the window when a chat stop went unconfirmed, and the CLI still gets its reply', async () => {
    const { sleep, notices } = coordinator({
      ensureStructuredAgentSessionHost: async () => {
        throw new Error('structured_agent_session_host_unavailable')
      }
    })
    await expect(sleep.sleepOwnWorktree(WORKTREE, {})).resolves.toMatchObject({
      chatFailed: true
    })
    expect(failedNotices(notices)).toEqual([
      expect.objectContaining({ outcome: expect.objectContaining({ chatFailed: true }) })
    ])
  })

  it('sends no toast for a sleep that succeeded', async () => {
    const { sleep, notices } = coordinator()
    await sleep.sleepOwnWorktree(WORKTREE, {})
    expect(failedNotices(notices)).toEqual([])
  })
})

it.each([true, false])(
  'an automatic=%s retry preserves Sleep/VM suspension intent',
  async (automatic) => {
    let finishStop: (result: RuntimeWorktreeTerminalSleepResult) => void = () => {}
    const stopped = new Promise<RuntimeWorktreeTerminalSleepResult>((resolve) => {
      finishStop = resolve
    })
    const suspendVm = vi.fn(async () => {})
    const ensureRestoredPaneStarted = vi.fn(async () => null)
    const stop = vi.fn(() => stopped)
    const { sleep } = coordinator({
      workspaceLifecycle: null,
      sleepTerminalsForWorktree: stop,
      ensureRestoredPaneStarted,
      workspaceSleepPlatform: {
        callEnvironment: async () => {
          throw new Error('unused')
        },
        suspendVm
      }
    })
    const sleeping = sleep.sleepOwnWorktree(WORKTREE, {})
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())
    const pane = { worktreeId: WORKTREE, tabId: 'tab', leafId: 'leaf' }
    await sleep.resumePane(pane, automatic)
    finishStop(verified)
    await sleeping
    expect(ensureRestoredPaneStarted).toHaveBeenCalledWith(pane, { automatic })
    expect(suspendVm).toHaveBeenCalledTimes(automatic ? 1 : 0)
  }
)
