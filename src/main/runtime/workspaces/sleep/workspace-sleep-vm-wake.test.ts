// A recipe VM's suspend and resume never overlap, and one reopening runs its resume once.
import { describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { WorkspaceSleepCoordinator, type WorkspaceSleepRuntime } from './workspace-sleep-runtime'
import type { WorkspaceSleepPlatform } from './workspace-sleep-platform'

const WORKTREE_ID = 'repo-1::/tmp/vm'

type Gate = { opened: Promise<void>; open: () => void }

function gate(): Gate {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

function coordinator(vm: Pick<WorkspaceSleepPlatform, 'suspendVm' | 'resumeVm'>) {
  const runtime: WorkspaceSleepRuntime = {
    workspaceLifecycle: null,
    workspaceSleepPlatform: {
      callEnvironment: async () => {
        throw new Error('no paired servers')
      },
      ownsVm: (workspaceId) => workspaceId === WORKTREE_ID,
      ...vm
    },
    listRepos: () => [],
    showManagedWorktree: async () => ({ id: WORKTREE_ID, repoId: 'repo-1' }),
    listTerminals: async () => ({ terminals: [] }),
    sleepTerminalsForWorktree: async () => ({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: [],
      postStopVerified: true
    }),
    ensureStructuredAgentSessionHost: async () => {},
    notifyWorkspaceSleep: () => {},
    wakeRecordsForWorktree: () => [],
    resumeSleptWorkspaceAgents: async () => {},
    ensureRestoredPaneStarted: async () => null,
    wakeWindowHibernatedAgents: () => {}
  }
  return new WorkspaceSleepCoordinator(runtime)
}

function sleep(workspaceSleep: WorkspaceSleepCoordinator) {
  return workspaceSleep.sleep({
    targets: [{ worktreeId: WORKTREE_ID, terminalHost: { kind: 'self' }, chatHosts: [] }]
  })
}

describe('WorkspaceSleepCoordinator VM wake', () => {
  it('resumes a VM opened mid-suspend only after the suspend finishes', async () => {
    const order: string[] = []
    const suspending = gate()
    const suspendStarted = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {
        order.push('suspend:start')
        suspendStarted.open()
        await suspending.opened
        order.push('suspend:end')
      },
      resumeVm: async () => {
        order.push('resume')
        return null
      }
    })

    const slept = sleep(workspaceSleep)
    await suspendStarted.opened
    const woke = workspaceSleep.wakeVm(WORKTREE_ID)
    suspending.open()
    await Promise.all([slept, woke])

    expect(order).toEqual(['suspend:start', 'suspend:end', 'resume'])
  })

  it('joins a wake already running instead of running the resume again', async () => {
    const resuming = gate()
    const resumeVm = vi.fn(async (): Promise<EphemeralVmRuntimeRecord | null> => {
      await resuming.opened
      return null
    })
    const workspaceSleep = coordinator({ suspendVm: async () => {}, resumeVm })

    const first = workspaceSleep.wakeVm(WORKTREE_ID)
    const second = workspaceSleep.wakeVm(WORKTREE_ID)
    resuming.open()
    await Promise.all([first, second])

    expect(resumeVm).toHaveBeenCalledTimes(1)
  })

  it('wakes again for a click after a suspend started instead of joining the older wake', async () => {
    const order: string[] = []
    const firstResume = gate()
    let resumes = 0
    const workspaceSleep = coordinator({
      suspendVm: async () => {
        order.push('suspend')
      },
      resumeVm: async () => {
        resumes += 1
        const resume = `resume:${resumes}`
        if (resumes === 1) {
          await firstResume.opened
        }
        order.push(resume)
        return null
      }
    })

    const olderWake = workspaceSleep.wakeVm(WORKTREE_ID)
    const slept = sleep(workspaceSleep)
    // The sleep's mocks all resolve at once, so one macrotask lets it ask for the suspend.
    await new Promise((resolve) => setImmediate(resolve))
    const click = workspaceSleep.wakeVm(WORKTREE_ID)
    firstResume.open()
    await Promise.all([olderWake, slept, click])

    expect(order).toEqual(['resume:1', 'suspend', 'resume:2'])
  })
})
