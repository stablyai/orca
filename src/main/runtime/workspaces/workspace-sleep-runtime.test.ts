import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import { WorkspaceSleepCoordinator, type WorkspaceSleepRuntime } from './workspace-sleep-runtime'

const ENVIRONMENT = 'box'
const verified: RuntimeWorktreeTerminalSleepResult = {
  stopped: 1,
  stoppedPtyIds: ['pty-1'],
  livePtyIds: ['pty-1'],
  postStopVerified: true
}

function coordinator(reread: () => Promise<void>) {
  const workspaceLifecycle = new WorkspaceLifecycleQueue()
  const runtime: WorkspaceSleepRuntime = {
    workspaceLifecycle,
    pairedServerRows: { rereadAfterChange: reread },
    workspaceSleepPlatform: {
      callEnvironment: async () => ({
        id: '1',
        ok: true,
        result: verified,
        _meta: { runtimeId: 'r' }
      }),
      suspendVm: async () => {}
    },
    listRepos: () => [],
    showManagedWorktree: async () => ({ id: 'repo::/w', repoId: 'repo' }),
    listTerminals: async () => ({ terminals: [] }),
    sleepTerminalsForWorktree: async () => verified,
    ensureStructuredAgentSessionHost: async () => {},
    notifyWorkspaceSleep: () => {},
    wakeRecordsForWorktree: () => [],
    resumeSleptWorkspaceAgents: async () => {},
    ensureRestoredPaneStarted: async () => null,
    wakeWindowHibernatedAgents: () => {}
  }
  return { sleep: new WorkspaceSleepCoordinator(runtime), workspaceLifecycle }
}

describe('WorkspaceSleepCoordinator', () => {
  it("holds a paired server's sleep hint until that server's rows are read again", async () => {
    let landRead!: () => void
    const reread = vi.fn(() => new Promise<void>((resolve) => (landRead = resolve)))
    const { sleep, workspaceLifecycle } = coordinator(reread)
    const sleeping = sleep.sleep({
      targets: [
        {
          worktreeId: 'repo::/w',
          terminalHost: { kind: 'environment', environmentId: ENVIRONMENT },
          chatHosts: []
        }
      ]
    })
    await vi.waitFor(() => expect(reread).toHaveBeenCalledWith(ENVIRONMENT))
    expect(Object.values(workspaceLifecycle.hints())).toEqual([
      expect.objectContaining({ kind: 'sleep' })
    ])
    landRead()
    const [outcome] = await sleeping
    expect(outcome?.failure).toBeUndefined()
    expect(workspaceLifecycle.hints()).toEqual({})
  })
})
