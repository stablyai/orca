import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-terminal-contracts'
import type { WorkspaceSleepTarget } from '../../../../shared/workspace-sleep'
import '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { WorkspaceLifecycleQueue } from '../lifecycle/workspace-lifecycle-queue'
import {
  sleepWorkspaces,
  type WorkspaceSleepDeps,
  type WorkspaceSleepQueue
} from './workspace-sleep-execution'

const SELF = { kind: 'self' } as const
const local = (worktreeId: string): WorkspaceSleepTarget => ({
  worktreeId,
  terminalHost: SELF,
  chatHosts: [SELF]
})
const slept = (ptyIds: string[]): RuntimeWorktreeTerminalSleepResult => ({
  stopped: ptyIds.length,
  stoppedPtyIds: ptyIds,
  livePtyIds: ptyIds,
  postStopVerified: true
})

function deps(overrides: Partial<WorkspaceSleepDeps> = {}) {
  const log: string[] = []
  const all: WorkspaceSleepDeps = {
    notify: (notice) => log.push(`${notice.phase} ${notice.worktreeId}`),
    vmWakeSettled: async () => {},
    sleepOwnTerminals: async (worktreeId) => {
      log.push(`terminals ${worktreeId}`)
      return slept([`pty-${worktreeId}`])
    },
    callEnvironment: () => async () => {
      throw new Error('no server')
    },
    stopOwnChats: async (worktreeId) => {
      log.push(`chats ${worktreeId}`)
      return { stoppedSessionIds: [`chat-${worktreeId}`] }
    },
    suspendVm: async (worktreeId, wanted) => {
      if (wanted()) {
        log.push(`vm ${worktreeId}`)
      }
    },
    ownRecords: () => [],
    watchReopen: () => () => false,
    ...overrides
  }
  return { log, deps: all }
}

function queued(queue = new WorkspaceLifecycleQueue()): WorkspaceSleepQueue {
  return {
    submit: (target, command) => queue.submit(target.worktreeId, command),
    paused: (target) => queue.pausedKeys().includes(target.worktreeId)
  }
}
const enqueue = queued()

describe('sleepWorkspaces', () => {
  // #36923: a Sleep asked for while the VM wakes keeps its place in the queue and stops what the
  // woken server runs once the wake is done.
  it('starts a sleep only once a wake of its VM under way has finished', async () => {
    const waking = Promise.withResolvers<void>()
    const { log, deps: d } = deps({ vmWakeSettled: () => waking.promise })
    const sleeping = sleepWorkspaces(d, queued(), { targets: [local('wt')] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(log).toEqual([])
    waking.resolve()
    await sleeping
    expect(log[0]).toBe('started wt')
  })

  it('suspends no VM until every workspace in the batch has stopped its chats', async () => {
    let releaseChats!: () => void
    const held = new Promise<void>((resolve) => (releaseChats = resolve))
    const { log, deps: d } = deps({
      stopOwnChats: async (worktreeId) => {
        if (worktreeId === 'wt-2') {
          await held
        }
        log.push(`chats ${worktreeId}`)
        return { stoppedSessionIds: [] }
      }
    })
    const sleeping = sleepWorkspaces(d, enqueue, { targets: [local('wt-1'), local('wt-2')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).not.toContain('vm wt-1')
    releaseChats()
    await sleeping
    expect(log.indexOf('chats wt-2')).toBeLessThan(log.indexOf('vm wt-1'))
  })

  it('keeps a workspace open when its host cannot prove the stop, and pauses its queue', async () => {
    const notices: unknown[] = []
    const { log, deps: d } = deps({
      notify: (notice) => notices.push(notice),
      sleepOwnTerminals: async () => ({
        stopped: 1,
        stoppedPtyIds: ['pty-a'],
        livePtyIds: ['pty-a', 'pty-b'],
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      })
    })
    const own = new WorkspaceLifecycleQueue()
    const [outcome] = await sleepWorkspaces(d, queued(own), { targets: [local('wt-1')] })
    expect(outcome).toEqual(
      expect.objectContaining({ worktreeId: 'wt-1', failure: 'terminal_liveness_unavailable' })
    )
    // The window rolls back only what was not proven stopped.
    expect(notices.at(-1)).toEqual({
      worktreeId: 'wt-1',
      phase: 'ended',
      slept: false,
      stoppedPtyIds: ['pty-a'],
      records: []
    })
    expect(log).not.toContain('vm wt-1')
    expect(own.pausedKeys().includes('wt-1')).toBe(true)
  })

  it('releases the batch when a delete cancels one workspace’s queued sleep', async () => {
    const own = new WorkspaceLifecycleQueue()
    let releaseHold!: () => void
    const hold = new Promise<void>((resolve) => (releaseHold = resolve))
    void own.submit('wt-2', { kind: 'close', run: () => hold })
    const { log, deps: d } = deps()
    const sleeping = sleepWorkspaces(d, queued(own), { targets: [local('wt-1'), local('wt-2')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    void own.submit('wt-2', { kind: 'delete', run: async () => undefined })
    const outcomes = await sleeping
    expect(outcomes[1]).toEqual(expect.objectContaining({ failure: 'workspace_deleted' }))
    expect(log).toContain('vm wt-1')
    releaseHold()
  })

  it('does not hold the batch for a workspace waiting behind a pause', async () => {
    const own = new WorkspaceLifecycleQueue(() => new Promise<void>(() => {}))
    await own.submit('wt-2', {
      kind: 'sleep',
      run: async () => undefined,
      outcome: () => 'unverifiable',
      observe: async () => {
        throw new Error('still unreachable')
      }
    })
    const { log, deps: d } = deps()
    void sleepWorkspaces(d, queued(own), { targets: [local('wt-1'), local('wt-2')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).toContain('vm wt-1')
    expect(log).not.toContain('terminals wt-2')
  })
})
