import { describe, expect, it } from 'vitest'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import { WORKSPACE_DELETED_ERROR, type LifecycleCommand } from './workspace-lifecycle-command'

const KEY = 'local|repo-1::/wt'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A command that records when it starts and finishes only when released. */
function gated<T>(
  log: string[],
  name: string,
  kind: LifecycleCommand<T>['kind'],
  value: T,
  extra: Partial<LifecycleCommand<T>> = {}
) {
  const gate = deferred()
  const command: LifecycleCommand<T> = {
    kind,
    run: async () => {
      log.push(`start ${name}`)
      await gate.promise
      log.push(`end ${name}`)
      return value
    },
    ...extra
  }
  return { command, release: () => gate.resolve() }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const deleteOptions = (key: string, force = false) => ({
  delete: { key, force, label: 'repo-1::/wt' }
})

/** A queue whose retries after a silent owner wait for the test to release them. */
function manualRetryQueue() {
  const retries: (() => void)[] = []
  const queue = new WorkspaceLifecycleQueue(
    () => new Promise<void>((resolve) => retries.push(resolve))
  )
  return { queue, retry: () => retries.splice(0).forEach((resolve) => resolve()) }
}

describe('WorkspaceLifecycleQueue', () => {
  it('runs one command at a time, in the order accepted, without merging kinds', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const sleep = gated(log, 'sleep', 'sleep', 'slept')
    const close = gated(log, 'close', 'close', 'closed')
    const secondSleep = gated(log, 'sleep-2', 'sleep', 'slept-2')
    const replies = [
      queue.submit(KEY, sleep.command),
      queue.submit(KEY, close.command),
      queue.submit(KEY, secondSleep.command)
    ]
    await flush()
    expect(log).toEqual(['start sleep'])
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'sleep', queuedBehind: 2 } })

    sleep.release()
    await flush()
    expect(log).toEqual(['start sleep', 'end sleep', 'start close'])
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'close', queuedBehind: 1 } })
    close.release()
    await flush()
    secondSleep.release()
    expect(await Promise.all(replies)).toEqual(['slept', 'closed', 'slept-2'])
    expect(log).toEqual([
      'start sleep',
      'end sleep',
      'start close',
      'end close',
      'start sleep-2',
      'end sleep-2'
    ])
    expect(queue.hints()).toEqual({})
  })

  it('runs a repeated command again rather than merging it into the first', async () => {
    const queue = new WorkspaceLifecycleQueue()
    let runs = 0
    const sleep: LifecycleCommand<number> = { kind: 'sleep', run: async () => ++runs }
    expect(await Promise.all([queue.submit(KEY, sleep), queue.submit(KEY, sleep)])).toEqual([1, 2])
  })

  it('keeps separate workspaces apart, including one id on two hosts', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const local = gated(log, 'local', 'sleep', 1)
    const ssh = gated(log, 'ssh', 'sleep', 2)
    void queue.submit(KEY, local.command)
    void queue.submit('ssh:box|repo-1::/wt', ssh.command)
    await flush()
    expect(log).toEqual(['start local', 'start ssh'])
    local.release()
    ssh.release()
  })

  it('delete cancels what has not started and waits for what has', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const sleep = gated(log, 'sleep', 'sleep', 'slept')
    const wake = gated(log, 'wake', 'wake', 'woken')
    const remove = gated(log, 'delete', 'delete', 'deleted', deleteOptions('normal'))
    const sleeping = queue.submit(KEY, sleep.command)
    const waking = queue.submit(KEY, wake.command)
    await flush()
    const deleting = queue.submit(KEY, remove.command)
    // Acknowledged at once: its hint replaces the queued ones.
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'delete', queuedBehind: 0 } })
    await expect(waking).rejects.toThrow(WORKSPACE_DELETED_ERROR)
    // A command after the delete is refused, not run on a workspace about to go.
    await expect(queue.submit(KEY, wake.command)).rejects.toThrow(WORKSPACE_DELETED_ERROR)
    expect(log).toEqual(['start sleep'])

    sleep.release()
    await flush()
    expect(log).toEqual(['start sleep', 'end sleep', 'start delete'])
    remove.release()
    expect(await sleeping).toBe('slept')
    expect(await deleting).toBe('deleted')
    expect(log).not.toContain('start wake')
  })

  it('joins a second delete with the same options, and refuses one with different options', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const remove = gated(log, 'delete', 'delete', 'deleted', deleteOptions('normal'))
    const first = queue.submit(KEY, remove.command)
    const second = queue.submit(
      KEY,
      gated(log, 'delete-2', 'delete', 'other', deleteOptions('normal')).command
    )
    await expect(
      queue.submit(KEY, gated(log, 'delete-3', 'delete', 'x', deleteOptions('hooks')).command)
    ).rejects.toThrow('Worktree deletion already in progress: repo-1::/wt')
    remove.release()
    expect(await Promise.all([first, second])).toEqual(['deleted', 'deleted'])
    expect(log).toEqual(['start delete', 'end delete'])
  })

  it('pauses on an unconfirmed outcome; re-observes when the owner answers, never replaying it', async () => {
    const { queue, retry } = manualRetryQueue()
    const log: string[] = []
    let reachable = false
    const sleep: LifecycleCommand<{ postStopVerified: boolean }> = {
      kind: 'sleep',
      run: async () => {
        log.push('sleep')
        return { postStopVerified: reachable }
      },
      outcome: (result) => (result.postStopVerified ? 'settled' : 'unverifiable'),
      observe: async () => {
        log.push('observe')
        if (!reachable) {
          throw new Error('terminal_liveness_unavailable')
        }
      }
    }
    // The requester gets the unconfirmed reply (today's toast); the workspace stays as observed.
    expect(await queue.submit(KEY, sleep)).toEqual({ postStopVerified: false })
    expect(queue.isPaused(KEY)).toBe(true)
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'sleep', queuedBehind: 0, paused: true } })

    // A command issued while paused waits behind the pause; it is neither refused nor run.
    const woke: string[] = []
    const waking = queue.submit(KEY, {
      kind: 'wake',
      run: async () => {
        woke.push('wake')
        return 'woken'
      }
    })
    await flush()
    expect(log).toEqual(['sleep', 'observe'])
    expect(woke).toEqual([])
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'wake', queuedBehind: 0, paused: true } })

    // Still silent on the next ask; then the owner answers and the queue carries on.
    retry()
    await flush()
    expect(log).toEqual(['sleep', 'observe', 'observe'])
    reachable = true
    retry()
    expect(await waking).toBe('woken')
    expect(log).toEqual(['sleep', 'observe', 'observe', 'observe'])
    expect(queue.isPaused(KEY)).toBe(false)
    expect(queue.hints()).toEqual({})
  })

  it('re-runs a repeated command once contact is back', async () => {
    const { queue } = manualRetryQueue()
    let reachable = false
    let sleeps = 0
    const sleep: LifecycleCommand<boolean> = {
      kind: 'sleep',
      run: async () => {
        sleeps += 1
        return reachable
      },
      outcome: (ok) => (ok ? 'settled' : 'unverifiable'),
      observe: async () => {
        if (!reachable) {
          throw new Error('lost')
        }
      }
    }
    expect(await queue.submit(KEY, sleep)).toBe(false)
    reachable = true
    expect(await queue.submit(KEY, sleep)).toBe(true)
    expect(sleeps).toBe(2)
    expect(queue.isPaused(KEY)).toBe(false)
  })

  it('pauses on lost contact mid-run, but not on a definite failure', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const lost = (message: string): LifecycleCommand<never> => ({
      kind: 'close',
      run: async () => {
        throw new Error(message)
      },
      lostContact: (error) => error instanceof Error && error.message === 'lost'
    })
    await expect(queue.submit(KEY, lost('refused'))).rejects.toThrow('refused')
    expect(queue.isPaused(KEY)).toBe(false)
    await expect(queue.submit(KEY, lost('lost'))).rejects.toThrow('lost')
    expect(queue.isPaused(KEY)).toBe(true)
  })

  it('acknowledges a delete issued while paused and runs it once the owner answers', async () => {
    const { queue, retry } = manualRetryQueue()
    const log: string[] = []
    let reachable = false
    await queue.submit(KEY, {
      kind: 'sleep',
      run: async () => false,
      outcome: () => 'unverifiable',
      observe: async () => {
        if (!reachable) {
          throw new Error('lost')
        }
      }
    })
    const deleting = queue.submit(KEY, {
      kind: 'delete',
      run: async () => {
        log.push('delete')
        return 'deleted'
      },
      ...deleteOptions('normal')
    })
    await flush()
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'delete', queuedBehind: 0, paused: true } })
    expect(log).toEqual([])
    reachable = true
    retry()
    expect(await deleting).toBe('deleted')
    expect(queue.isPaused(KEY)).toBe(false)
  })

  it('runs a forced delete past the pause at once, in place of an unforced one waiting', async () => {
    const { queue } = manualRetryQueue()
    const log: string[] = []
    await queue.submit(KEY, {
      kind: 'sleep',
      run: async () => false,
      outcome: () => 'unverifiable',
      observe: () => new Promise<void>(() => {})
    })
    const waiting = queue.submit(KEY, {
      kind: 'delete',
      run: async () => 'unforced',
      ...deleteOptions('normal')
    })
    await flush()
    const forced = queue.submit(KEY, {
      kind: 'delete',
      run: async () => {
        log.push('forced')
        return 'deleted'
      },
      ...deleteOptions('force', true)
    })
    await expect(waiting).rejects.toThrow(WORKSPACE_DELETED_ERROR)
    expect(await forced).toBe('deleted')
    expect(log).toEqual(['forced'])
    expect(queue.isPaused(KEY)).toBe(false)
  })

  it('starts commands in arrival order even when an earlier one is still looking up its workspace', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const lookup = deferred<string | null>()
    const first = queue.submitResolving(() => lookup.promise, {
      kind: 'sleep',
      run: async () => {
        log.push('sleep (by name)')
        return 'slept'
      }
    })
    const second = queue.submit(KEY, {
      kind: 'wake',
      run: async () => {
        log.push('wake (by id)')
        return 'woken'
      }
    })
    await flush()
    expect(log).toEqual([])
    lookup.resolve(KEY)
    expect(await Promise.all([first, second])).toEqual(['slept', 'woken'])
    expect(log).toEqual(['sleep (by name)', 'wake (by id)'])
  })

  it('lets a lookup stuck on a dead host hold another workspace only briefly', async () => {
    let clock = 0
    const queue = new WorkspaceLifecycleQueue(
      async (ms) => {
        clock += ms
      },
      () => clock
    )
    void queue.submitResolving(() => new Promise<string | null>(() => {}), {
      kind: 'sleep',
      run: async () => 'never'
    })
    const other = queue.submit('ssh:other|r::/w', { kind: 'wake', run: async () => 'woken' })
    expect(await other).toBe('woken')
    expect(clock).toBe(500)
  })

  it('never cancels a command because its requester went away', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const sleep = gated(log, 'sleep', 'sleep', 'slept')
    // The requester drops its reply (a phone disconnect); the command still runs to its end.
    void queue.submit(KEY, sleep.command).catch(() => {})
    await flush()
    sleep.release()
    await flush()
    expect(log).toEqual(['start sleep', 'end sleep'])
  })

  it('leaves nothing pending in a fresh queue, as after a restart', () => {
    const queue = new WorkspaceLifecycleQueue()
    expect(queue.hints()).toEqual({})
    expect(queue.creationsSnapshot().creations).toEqual({})
  })
})

describe('WorkspaceLifecycleQueue creates', () => {
  it('lists a creation once opened, names its workspace, and drops it on close', () => {
    const queue = new WorkspaceLifecycleQueue()
    const creation = queue.openCreate({ creationId: 'c1', repoId: 'repo-1' })
    expect(queue.creationsSnapshot().creations).toEqual({ c1: { repoId: 'repo-1' } })
    const opened = queue.creationsSnapshot().revision
    creation.named('repo-1::/wt')
    expect(queue.creationsSnapshot().creations).toEqual({
      c1: { repoId: 'repo-1', worktreeId: 'repo-1::/wt' }
    })
    expect(queue.creationsSnapshot().revision).toBeGreaterThan(opened)
    creation.close()
    expect(queue.creationsSnapshot().creations).toEqual({})
  })

  it('mints an id for a caller that sends none', () => {
    const queue = new WorkspaceLifecycleQueue()
    const creation = queue.openCreate({ repoId: 'repo-1' })
    const ids = Object.keys(queue.creationsSnapshot().creations)
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toBe('')
    creation.close()
    expect(queue.creationsSnapshot().creations).toEqual({})
  })

  it('leaves a concurrent retry under the same id listed when the first create closes', () => {
    const queue = new WorkspaceLifecycleQueue()
    const first = queue.openCreate({ creationId: 'c1', repoId: 'repo-1' })
    const second = queue.openCreate({ creationId: 'c1', repoId: 'repo-1' })
    first.named('repo-1::/stale')
    first.close()
    expect(queue.creationsSnapshot().creations).toEqual({ c1: { repoId: 'repo-1' } })
    second.close()
    expect(queue.creationsSnapshot().creations).toEqual({})
  })

  it('frees the workspace queue when a create closes after a retry took over its id', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const first = queue.openCreate({ creationId: 'c1', repoId: 'repo-1', keyOf: () => KEY })
    first.named('repo-1::/wt')
    const retry = queue.openCreate({ creationId: 'c1', repoId: 'repo-1', keyOf: () => KEY })
    const sleeping = queue.submit(KEY, { kind: 'sleep', run: async () => 'slept' })
    first.close()
    expect(await sleeping).toBe('slept')
    retry.close()
  })

  it('closes once', () => {
    const queue = new WorkspaceLifecycleQueue()
    const creation = queue.openCreate({ creationId: 'c1', repoId: 'repo-1' })
    creation.close()
    const closed = queue.creationsSnapshot().revision
    creation.close()
    expect(queue.creationsSnapshot().revision).toBe(closed)
  })

  it('binds to the workspace once named, so commands on the Creating row wait behind it', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const creation = queue.openCreate({ creationId: 'c1', repoId: 'repo-1', keyOf: () => KEY })
    creation.named('repo-1::/wt')
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'create', queuedBehind: 0 } })
    const sleep = gated(log, 'sleep', 'sleep', 'slept')
    const sleeping = queue.submit(KEY, sleep.command)
    await flush()
    expect(log).toEqual([])
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'create', queuedBehind: 1 } })
    creation.close()
    await flush()
    expect(log).toEqual(['start sleep'])
    sleep.release()
    expect(await sleeping).toBe('slept')
  })

  it('lets a delete cancel what waits behind a create and run once the create ends', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const creation = queue.openCreate({ creationId: 'c1', repoId: 'repo-1', keyOf: () => KEY })
    creation.named('repo-1::/wt')
    const sleeping = queue.submit(KEY, gated(log, 'sleep', 'sleep', 'slept').command)
    const remove = gated(log, 'delete', 'delete', 'deleted')
    const deleting = queue.submit(KEY, remove.command)
    await expect(sleeping).rejects.toThrow(WORKSPACE_DELETED_ERROR)
    await flush()
    expect(log).toEqual([])
    creation.close()
    await flush()
    expect(log).toEqual(['start delete'])
    remove.release()
    expect(await deleting).toBe('deleted')
  })
})

describe('WorkspaceLifecycleQueue create fencing', () => {
  it('never puts a new create behind the previous occupant’s delete', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const log: string[] = []
    const sleep = gated(log, 'sleep', 'sleep', 'slept')
    void queue.submit(KEY, sleep.command)
    const deleting = queue.submit(KEY, gated(log, 'delete', 'delete', 'deleted').command)
    const creation = queue.openCreate({ creationId: 'c1', repoId: 'repo-1', keyOf: () => KEY })
    creation.named('repo-1::/wt')
    // The delete still waits on the sleep alone; the create is not one of its commands.
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'delete', queuedBehind: 0 } })
    creation.close()
    sleep.release()
    await flush()
    expect(log).toEqual(['start sleep', 'end sleep', 'start delete'])
    void deleting
  })
})

describe('WorkspaceLifecycleQueue membership', () => {
  /** A listing whose fresh scan the test applies by hand. */
  function listing() {
    const waiters: (() => void)[] = []
    return {
      membership: (done: () => void) => waiters.push(done),
      applyFreshScan: () => waiters.splice(0).forEach((done) => done())
    }
  }

  it('holds a finished create’s hint until a fresh listing, then drops it in that revision', () => {
    const queue = new WorkspaceLifecycleQueue()
    const rows = listing()
    queue.setMembership(rows.membership)
    const creation = queue.openCreate({ creationId: 'c1', repoId: 'repo-1', keyOf: () => KEY })
    creation.named('repo-1::/wt')
    creation.close()
    // A scan that started before the create ended cannot drop the row: the creation still shows.
    expect(queue.creationsSnapshot().creations).toEqual({
      c1: { repoId: 'repo-1', worktreeId: 'repo-1::/wt' }
    })
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'create', queuedBehind: 0 } })
    const bumps: number[] = []
    queue.revision.onChange(() => bumps.push(queue.revision.value))
    rows.applyFreshScan()
    expect(queue.creationsSnapshot().creations).toEqual({})
    expect(queue.hints()).toEqual({})
    // One synchronous bump, inside the listing's apply: the feed flushes both together.
    expect(bumps).toHaveLength(1)
  })

  it('drops a failed create at once, with nothing to list', () => {
    const queue = new WorkspaceLifecycleQueue()
    const rows = listing()
    queue.setMembership(rows.membership)
    queue.openCreate({ creationId: 'c1', repoId: 'repo-1' }).close()
    expect(queue.creationsSnapshot().creations).toEqual({})
  })

  it('shows a finished delete until a fresh listing drops the row', async () => {
    const queue = new WorkspaceLifecycleQueue()
    const rows = listing()
    queue.setMembership(rows.membership)
    expect(await queue.submit(KEY, { kind: 'delete', run: async () => 'deleted' })).toBe('deleted')
    expect(queue.hints()).toEqual({ [KEY]: { kind: 'delete', queuedBehind: 0 } })
    rows.applyFreshScan()
    expect(queue.hints()).toEqual({})
  })
})
