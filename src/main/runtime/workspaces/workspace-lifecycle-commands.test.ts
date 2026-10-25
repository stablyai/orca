import { describe, expect, it } from 'vitest'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import {
  closeOutcome,
  deleteLostContact,
  observeTerminals,
  queueTerminalWorkspaceCommand,
  queueWorkspaceDelete,
  sleepOutcome,
  terminalLostContact,
  workspaceLifecycleKey
} from './workspace-lifecycle-commands'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const repos = [
  { id: 'repo-local', connectionId: null, executionHostId: null },
  { id: 'repo-ssh', connectionId: 'box', executionHostId: null }
]

const BY_NAME: Record<string, string> = { feature: 'repo-local::/a' }

function runtime(queue: WorkspaceLifecycleQueue | null) {
  return {
    workspaceLifecycle: queue,
    listRepos: () => repos,
    showManagedWorktree: async (selector: string) => {
      const id = BY_NAME[selector] ?? selector.replace(/^id:/, '')
      if (!id.includes('::')) {
        throw new Error('selector_not_found')
      }
      return { id, repoId: id.split('::')[0] }
    },
    listTerminals: async () => ({ totalCount: 0 })
  }
}

const removal = {
  force: true,
  runHooks: false,
  allowUnverifiedPtyStop: false,
  allowFailedArchiveHook: false
}

describe('workspace lifecycle commands', () => {
  it('runs directly in a build with no queue', async () => {
    let ran = false
    const reply = await queueTerminalWorkspaceCommand(runtime(null), 'id:repo-local::/a', {
      kind: 'sleep',
      run: async () => {
        ran = true
        return 'slept'
      }
    })
    expect([ran, reply]).toEqual([true, 'slept'])
  })

  it('keys a command by the host its repo routes to, the same key a delete uses', async () => {
    const queue = new WorkspaceLifecycleQueue()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sleeping = queueTerminalWorkspaceCommand(runtime(queue), 'id:repo-ssh::/a', {
      kind: 'sleep',
      run: () => gate
    })
    await flush()
    expect(queue.hints()).toEqual({
      [workspaceLifecycleKey('ssh:box', 'repo-ssh::/a')]: { kind: 'sleep', queuedBehind: 0 }
    })
    release()
    await sleeping
  })

  it('makes a delete by name wait for the running sleep of the workspace it names', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sleeping = queueTerminalWorkspaceCommand(runtime(queue), 'id:repo-local::/a', {
      kind: 'sleep',
      run: async () => {
        log.push('sleep')
        await gate
        log.push('slept')
      }
    })
    const deleting = queueWorkspaceDelete(
      runtime(queue),
      'feature',
      undefined,
      removal,
      async () => {
        log.push('delete')
      }
    )
    await flush()
    expect(log).toEqual(['sleep'])
    expect(queue.hints()).toEqual({
      [workspaceLifecycleKey('local', 'repo-local::/a')]: { kind: 'delete', queuedBehind: 0 }
    })
    release()
    await Promise.all([sleeping, deleting])
    expect(log).toEqual(['sleep', 'slept', 'delete'])
  })

  it('runs a delete of a workspace no lookup finds without queueing it', async () => {
    const queue = new WorkspaceLifecycleQueue()
    let ran = false
    await queueWorkspaceDelete(runtime(queue), 'gone', undefined, removal, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('reads lost contact the same way for sleep, close and delete', async () => {
    expect(terminalLostContact(new Error('terminal_liveness_unavailable'))).toBe(true)
    expect(terminalLostContact(new Error('terminal_worktree_sleep_failed'))).toBe(false)
    expect(
      deleteLostContact(new Error('Timed out waiting for physical PTY teardown: repo::/a.'))
    ).toBe(true)
    expect(deleteLostContact(new Error('Repo not found: repo'))).toBe(false)
    const silent = {
      listTerminals: async () => {
        throw new Error('terminal_liveness_unavailable')
      }
    }
    await expect(observeTerminals(silent, 'id:a')()).rejects.toThrow()
    const gone = {
      listTerminals: async () => {
        throw new Error('selector_not_found')
      }
    }
    await expect(observeTerminals(gone, 'id:a')()).resolves.toBeUndefined()
  })

  it('reads an unconfirmed sleep or close as unverifiable, and an observed result as settled', () => {
    const sleep = { stopped: 1, stoppedPtyIds: [], livePtyIds: [] }
    expect(
      sleepOutcome({
        ...sleep,
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      })
    ).toBe('unverifiable')
    expect(
      sleepOutcome({
        ...sleep,
        postStopVerified: false,
        postStopFailure: 'terminal_worktree_sleep_still_live',
        remainingLivePtyIds: ['pty-1']
      })
    ).toBe('settled')
    expect(
      sleepOutcome({ stopped: 1, stoppedPtyIds: [], livePtyIds: [], postStopVerified: true })
    ).toBe('settled')
    const closed = { closed: 1, stopped: 1, retiredSurfaces: true as const }
    expect(closeOutcome({ ...closed, ptyStopVerdict: 'unverifiable' })).toBe('unverifiable')
    expect(closeOutcome({ ...closed, ptyStopVerdict: 'live' })).toBe('settled')
  })
})
