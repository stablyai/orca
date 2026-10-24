import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type { WorkspaceSleepNotice, WorkspaceSleepTarget } from '../../../shared/workspace-sleep'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import {
  sleepWorkspaces,
  type WorkspaceSleepDeps,
  type WorkspaceSleepQueue
} from './workspace-sleep-execution'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

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
    suspendVm: async (worktreeId) => {
      log.push(`vm ${worktreeId}`)
    },
    ownRecords: () => [],
    watchReopen: () => () => false,
    ...overrides
  }
  return { log, deps: all }
}

/** Each workspace's sleep in `queue`, keyed by its id. */
function queued(queue = new WorkspaceLifecycleQueue()): WorkspaceSleepQueue {
  return {
    submit: (target, command) => queue.submit(target.worktreeId, command),
    paused: (target) => queue.pausedKeys().includes(target.worktreeId)
  }
}
const enqueue = queued()

describe('sleepWorkspaces', () => {
  it('correlates a project move with renderer notices and retains chat stop receipts without marking chats asleep', async () => {
    const notices: WorkspaceSleepNotice[] = []
    const { deps: d } = deps({
      notify: (notice) => notices.push(notice),
      stopOwnChats: async (_id, markAsleep) => {
        expect(markAsleep).toBe(false)
        return { stoppedSessionIds: ['chat'] }
      }
    })
    const outcomes = await sleepWorkspaces(d, queued(), {
      targets: [local('wt')],
      markChatsAsleep: false,
      projectMovePauseId: 'move-1'
    })
    expect(notices).toEqual([
      { worktreeId: 'wt', phase: 'started', projectMovePauseId: 'move-1' },
      {
        worktreeId: 'wt',
        phase: 'ended',
        projectMovePauseId: 'move-1',
        slept: true,
        stoppedPtyIds: ['pty-wt'],
        records: []
      }
    ])
    expect(outcomes).toEqual([
      {
        worktreeId: 'wt',
        chatFailed: false,
        receipts: [{ executionHostId: 'local', stoppedSessionIds: ['chat'] }]
      }
    ])
  })

  it('runs a sleep in order: the window follows, terminals stop, chats stop, then the VM', async () => {
    const { log, deps: d } = deps()
    const outcomes = await sleepWorkspaces(d, enqueue, {
      targets: [local('wt-1')],
      markChatsAsleep: true
    })
    expect(log).toEqual(['started wt-1', 'terminals wt-1', 'chats wt-1', 'vm wt-1', 'ended wt-1'])
    expect(outcomes).toEqual([
      {
        worktreeId: 'wt-1',
        chatFailed: false,
        receipts: [{ executionHostId: 'local', stoppedSessionIds: ['chat-wt-1'] }]
      }
    ])
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

  it('treats a terminal observed still live as a definite failure, not a pause', async () => {
    const { deps: d } = deps({
      sleepOwnTerminals: async () => ({
        stopped: 0,
        stoppedPtyIds: [],
        livePtyIds: ['pty-a'],
        postStopVerified: false,
        postStopFailure: 'terminal_worktree_sleep_still_live',
        remainingLivePtyIds: ['pty-a']
      })
    })
    const own = new WorkspaceLifecycleQueue()
    const [outcome] = await sleepWorkspaces(d, queued(own), { targets: [local('wt-1')] })
    expect(outcome?.failure).toBe('terminal_worktree_sleep_still_live')
    expect(own.pausedKeys().includes('wt-1')).toBe(false)
  })

  it('reports a chat stop that answered with a failure, keeps the terminals asleep, no pause', async () => {
    const { log, deps: d } = deps({
      stopOwnChats: async () => ({
        stoppedSessionIds: [],
        failures: [{ reason: 'stop-unverifiable' }]
      })
    })
    const own = new WorkspaceLifecycleQueue()
    const [outcome] = await sleepWorkspaces(d, queued(own), { targets: [local('wt-1')] })
    expect(outcome).toEqual(expect.objectContaining({ chatFailed: true }))
    expect(outcome?.failure).toBeUndefined()
    expect(log).toContain('vm wt-1')
    expect(own.pausedKeys().includes('wt-1')).toBe(false)
  })

  it('pauses only when a paired server never answered the chat stop', async () => {
    const env = { kind: 'environment', environmentId: 'env-a' } as const
    const lost = deps({
      callEnvironment: () => async (method) => {
        if (method === 'terminal.sleep') {
          return { stopped: 0, stoppedPtyIds: [], livePtyIds: [], postStopVerified: true }
        }
        throw new Error('connection closed')
      }
    })
    const own = new WorkspaceLifecycleQueue()
    const target = { worktreeId: 'wt-r', terminalHost: env, chatHosts: [env] }
    const [outcome] = await sleepWorkspaces(lost.deps, queued(own), { targets: [target] })
    expect(outcome?.chatFailed).toBe(true)
    expect(own.pausedKeys().includes('wt-r')).toBe(true)
  })

  it("reads a paired server's still-live answer as a plain failure, and a lost one as unconfirmed", async () => {
    const env = { kind: 'environment', environmentId: 'env-a' } as const
    const target = { worktreeId: 'wt-r', terminalHost: env, chatHosts: [] }
    const answering = deps({
      callEnvironment: () => async () => ({
        stopped: 0,
        stoppedPtyIds: [],
        livePtyIds: ['pty-1'],
        postStopVerified: false,
        postStopFailure: 'terminal_worktree_sleep_still_live',
        remainingLivePtyIds: ['pty-1']
      })
    })
    const own = new WorkspaceLifecycleQueue()
    const [still] = await sleepWorkspaces(answering.deps, queued(own), { targets: [target] })
    expect(still?.failure).toBe('terminal_worktree_sleep_still_live')
    expect(own.pausedKeys().includes('wt-r')).toBe(false)
    const silent = deps({
      callEnvironment: () => async () => {
        throw new Error('timed out')
      }
    })
    await sleepWorkspaces(silent.deps, queued(own), { targets: [target] })
    expect(own.pausedKeys().includes('wt-r')).toBe(true)
  })

  it("sleeps a paired server's copy on that server, with its PTY ids as the window binds them", async () => {
    const calls: [string, unknown][] = []
    const notices: unknown[] = []
    const { deps: d } = deps({
      notify: (notice) => notices.push(notice),
      callEnvironment: () => async (method, params) => {
        calls.push([method, params])
        if (method === 'terminal.sleep') {
          return {
            stopped: 1,
            stoppedPtyIds: ['pty-1'],
            livePtyIds: ['pty-1'],
            postStopVerified: true
          }
        }
        if (params && typeof params === 'object' && 'markAsleep' in params) {
          throw Object.assign(new Error('Unrecognized key: markAsleep'), {
            code: 'invalid_argument'
          })
        }
        return { stoppedSessionIds: ['chat-1'] }
      }
    })
    const env = { kind: 'environment', environmentId: 'env-a' } as const
    const [outcome] = await sleepWorkspaces(d, enqueue, {
      targets: [{ worktreeId: 'wt-r', terminalHost: env, chatHosts: [env] }],
      markChatsAsleep: true
    })
    // A server that predates Sleep's mark refuses the field, so it is asked again without it.
    expect(calls).toEqual([
      ['terminal.sleep', { worktree: 'id:wt-r' }],
      ['agentSession.sleepWorkspace', { workspaceId: 'wt-r', markAsleep: true }],
      ['agentSession.sleepWorkspace', { workspaceId: 'wt-r' }]
    ])
    expect(outcome?.receipts).toEqual([
      { executionHostId: 'runtime:env-a', stoppedSessionIds: ['chat-1'] }
    ])
    expect(notices.at(-1)).toEqual({
      worktreeId: 'wt-r',
      phase: 'ended',
      slept: true,
      stoppedPtyIds: [toRemoteRuntimePtyId('pty-1', 'env-a')],
      records: null
    })
  })

  it("stops an older server's terminals and polls until none is live", async () => {
    const methods: string[] = []
    const { deps: d } = deps({
      callEnvironment: () => async (method) => {
        methods.push(method)
        if (method === 'terminal.sleep') {
          throw Object.assign(new Error('unknown'), { code: 'method_not_found' })
        }
        return method === 'terminal.list'
          ? { terminals: [], totalCount: 0, truncated: false }
          : { stoppedSessionIds: [] }
      }
    })
    const env = { kind: 'environment', environmentId: 'env-old' } as const
    const [outcome] = await sleepWorkspaces(d, enqueue, {
      targets: [{ worktreeId: 'wt-o', terminalHost: env, chatHosts: [] }]
    })
    expect(methods).toEqual(['terminal.sleep', 'terminal.stop', 'terminal.list'])
    expect(outcome?.failure).toBeUndefined()
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

  it('leaves the VM running when the workspace is reopened mid-sleep', async () => {
    let reopened = false
    const { log, deps: d } = deps({
      stopOwnChats: async () => {
        reopened = true
        return { stoppedSessionIds: [] }
      },
      watchReopen: () => () => reopened
    })
    const [outcome] = await sleepWorkspaces(d, enqueue, { targets: [local('wt-1')] })
    expect(log).not.toContain('vm wt-1')
    expect(outcome?.failure).toBeUndefined()
  })

  it("hands the window main's wake records once the terminals stopped", async () => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const notices: unknown[] = []
    const { deps: d } = deps({
      notify: (notice) => notices.push(notice),
      ownRecords: (worktreeId) => (worktreeId === 'wt-1' ? [record] : [])
    })
    await sleepWorkspaces(d, enqueue, { targets: [local('wt-1')] })
    expect(notices.at(-1)).toEqual(expect.objectContaining({ phase: 'ended', records: [record] }))
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

  it('suspends nothing on a host without VM support', async () => {
    const { log, deps: d } = deps({ suspendVm: null })
    await sleepWorkspaces(d, enqueue, { targets: [local('wt-1')] })
    expect(log).toEqual(['started wt-1', 'terminals wt-1', 'chats wt-1', 'ended wt-1'])
  })

  it('reports a VM that would not suspend apart from the sleep, which still ended asleep', async () => {
    const notices: unknown[] = []
    const { deps: d } = deps({
      notify: (notice) => notices.push(notice),
      suspendVm: async () => {
        throw new Error('vm busy')
      }
    })
    const [outcome] = await sleepWorkspaces(d, queued(), { targets: [local('wt-1')] })
    expect(outcome?.failure).toBeUndefined()
    expect(outcome?.vmSuspendFailure).toBe('vm busy')
    expect(notices.at(-1)).toEqual(expect.objectContaining({ phase: 'ended', slept: true }))
  })
})
