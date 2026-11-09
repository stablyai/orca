// A recipe VM's suspend and resume never overlap, and one reopening runs its resume once.
import { describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { WorkspaceSleepCoordinator, type WorkspaceSleepRuntime } from './workspace-sleep-runtime'
import type { WorkspaceSleepPlatform } from './workspace-sleep-platform'
import type { WorkspaceLifecycleQueue } from '../lifecycle/workspace-lifecycle-queue'

const WORKTREE_ID = 'repo-1::/tmp/vm'

type Gate = { opened: Promise<void>; open: () => void }

function gate(): Gate {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

function coordinator(
  vm: Pick<WorkspaceSleepPlatform, 'suspendVm' | 'resumeVm'>,
  workspaceLifecycle: WorkspaceLifecycleQueue | null = null
) {
  const runtime: WorkspaceSleepRuntime = {
    workspaceLifecycle,
    workspaceSleepPlatform: {
      callEnvironment: async () => {
        throw new Error('no paired servers')
      },
      ownsVm: (workspaceId) => workspaceId === WORKTREE_ID,
      acceptWake: () => ({ sshHeld: false, sshUserDisconnects: 0 }),
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

  it('destroys the VM only after a wake still running for it settles', async () => {
    const order: string[] = []
    const resuming = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {},
      resumeVm: async () => {
        order.push('resume:start')
        await resuming.opened
        order.push('resume:end')
        return null
      }
    })

    const woke = workspaceSleep.wakeVm(WORKTREE_ID)
    const destroyed = workspaceSleep.destroyVm(WORKTREE_ID, async () => {
      order.push('destroy')
    })
    resuming.open()
    await Promise.all([woke, destroyed])

    expect(order).toEqual(['resume:start', 'resume:end', 'destroy'])
  })

  it('keeps the VM up when the workspace is opened while its suspend waits behind a wake', async () => {
    const order: string[] = []
    const resuming = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {
        order.push('suspend')
      },
      resumeVm: async () => {
        await resuming.opened
        order.push('resume')
        return null
      }
    })

    const woke = workspaceSleep.wakeVm(WORKTREE_ID)
    const slept = sleep(workspaceSleep)
    // The sleep's mocks all resolve at once, so one macrotask lets it queue the suspend.
    await new Promise((resolve) => setImmediate(resolve))
    // A slept pane opened: it counts as a reopen but does not wake the VM itself.
    workspaceSleep.noteReopened(WORKTREE_ID)
    resuming.open()
    await Promise.all([woke, slept])

    expect(order).toEqual(['resume'])
  })

  // #36923: clients reaching the VM's server learn where it stands from its pending operations,
  // which outrank a stored record that lags them.
  it('reports a VM waking from its wake until the resume settles, even when it fails', async () => {
    const resuming = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {},
      resumeVm: async () => {
        await resuming.opened
        throw new Error('recipe resume failed')
      }
    })

    expect(workspaceSleep.vmState(WORKTREE_ID, true)).toBe('asleep')
    const woke = workspaceSleep.wakeVm(WORKTREE_ID)
    // The record may already say running while the wake still reconnects.
    expect(workspaceSleep.vmState(WORKTREE_ID, false)).toBe('waking')
    resuming.open()
    await expect(woke).rejects.toThrow('recipe resume failed')
    expect(workspaceSleep.vmState(WORKTREE_ID, true)).toBe('asleep')
  })

  it('keeps reporting a wake still reconnecting as waking, though a sleep queued a suspend after it', async () => {
    const resuming = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {},
      resumeVm: async () => {
        await resuming.opened
        return null
      }
    })

    const woke = workspaceSleep.wakeVm(WORKTREE_ID)
    const slept = sleep(workspaceSleep)
    await new Promise((resolve) => setImmediate(resolve))
    expect(workspaceSleep.vmState(WORKTREE_ID, false)).toBe('waking')
    resuming.open()
    await Promise.all([woke, slept])
  })

  // The host holds a client's open of the workspace until the VM is up.
  it('holds an open until its wake brings the VM up, joining a wake already pending', async () => {
    const resuming = gate()
    const resumeVm = vi.fn(async (): Promise<EphemeralVmRuntimeRecord | null> => {
      await resuming.opened
      return null
    })
    const workspaceSleep = coordinator({ suspendVm: async () => {}, resumeVm })

    const first = workspaceSleep.holdOpen(WORKTREE_ID, true, 60_000)
    const second = workspaceSleep.holdOpen(WORKTREE_ID, false, 60_000)
    resuming.open()

    await expect(Promise.all([first, second])).resolves.toEqual(['up', 'up'])
    expect(resumeVm).toHaveBeenCalledTimes(1)
  })

  it('holds an open behind a running suspend, then wakes the VM', async () => {
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
    // The record still says running while the recipe's suspend runs.
    expect(workspaceSleep.vmState(WORKTREE_ID, false)).toBe('asleep')
    const opened = workspaceSleep.holdOpen(WORKTREE_ID, false, 60_000)
    suspending.open()
    await slept

    await expect(opened).resolves.toBe('up')
    expect(order).toEqual(['suspend:start', 'suspend:end', 'resume'])
  })

  it('keeps a running VM up for an open that lands while a sleep is on its way', async () => {
    const suspendVm = vi.fn(async () => {})
    const workspaceSleep = coordinator({ suspendVm, resumeVm: async () => null })

    const slept = sleep(workspaceSleep)
    await expect(workspaceSleep.holdOpen(WORKTREE_ID, false, 60_000)).resolves.toBe('up')
    await slept

    expect(suspendVm).not.toHaveBeenCalled()
  })

  it('lets a Sleep asked for while an open is held win', async () => {
    const order: string[] = []
    const resuming = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {
        order.push('suspend')
      },
      resumeVm: async () => {
        await resuming.opened
        order.push('resume')
        return null
      }
    })

    const opened = workspaceSleep.holdOpen(WORKTREE_ID, true, 60_000)
    const slept = sleep(workspaceSleep)
    await expect(opened).resolves.toBe('slept')
    resuming.open()
    await slept

    // The held open woke nothing more: the Sleep's suspend runs last.
    expect(order).toEqual(['resume', 'suspend'])
  })

  it('answers a failed wake to the held open, and the next open tries again', async () => {
    const resumeVm = vi.fn(async (): Promise<EphemeralVmRuntimeRecord | null> => {
      throw new Error('recipe resume failed')
    })
    const workspaceSleep = coordinator({ suspendVm: async () => {}, resumeVm })

    await expect(workspaceSleep.holdOpen(WORKTREE_ID, true, 60_000)).resolves.toBe('wake-failed')
    await expect(workspaceSleep.holdOpen(WORKTREE_ID, true, 60_000)).resolves.toBe('wake-failed')
    expect(resumeVm).toHaveBeenCalledTimes(2)
  })

  it('answers waking when the hold runs out before the VM is up', async () => {
    const resuming = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {},
      resumeVm: async () => {
        await resuming.opened
        return null
      }
    })

    await expect(workspaceSleep.holdOpen(WORKTREE_ID, true, 5)).resolves.toBe('waking')
    resuming.open()
  })

  it('stops a workspace asked to sleep during a wake only after the wake, unless it is opened again', async () => {
    const order: string[] = []
    const resuming = gate()
    const workspaceSleep = coordinator({
      suspendVm: async () => {
        order.push('suspend')
      },
      resumeVm: async () => {
        await resuming.opened
        order.push('resume')
        return null
      }
    })

    const woke = workspaceSleep.wakeVm(WORKTREE_ID)
    const slept = sleep(workspaceSleep)
    // Opened after the Sleep was asked for, while the wake still runs: the open wins.
    const opened = workspaceSleep.holdOpen(WORKTREE_ID, false, 60_000)
    resuming.open()
    await Promise.all([woke, slept])

    await expect(opened).resolves.toBe('up')
    expect(order).toEqual(['resume'])
  })

  // A caller that gives up (its phone gone, its request cancelled) frees its place; the wake goes on.
  it('lets an aborted caller stop waiting on a held open while the wake continues', async () => {
    const resuming = gate()
    const resumeVm = vi.fn(async (): Promise<EphemeralVmRuntimeRecord | null> => {
      await resuming.opened
      return null
    })
    const workspaceSleep = coordinator({ suspendVm: async () => {}, resumeVm })
    const caller = new AbortController()

    const opened = workspaceSleep.holdOpen(WORKTREE_ID, true, 60_000, caller.signal)
    caller.abort(new Error('caller went away'))
    await expect(opened).rejects.toThrow('caller went away')
    resuming.open()
    await vi.waitFor(() => expect(workspaceSleep.vmState(WORKTREE_ID, false)).toBe('up'))
    expect(resumeVm).toHaveBeenCalledTimes(1)
  })
})
