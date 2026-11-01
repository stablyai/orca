import { describe, expect, it, vi } from 'vitest'
import * as worktreePaths from '../git/worktree-path-comparison'
import {
  acquireWatcherRemovalGate,
  beginTerminalInstall,
  beginWatcherInstall,
  TerminalRemovalInProgressError,
  WatcherRemovalInProgressError
} from './watcher-removal-gate'
import { isWorktreeRemovalFenceError } from '../../shared/worktree/removal-fence-error'

describe('watcher removal gate', () => {
  it.each([
    ['C:\\Repo', 'c:/repo/', 'C:/REPO'],
    ['\\\\wsl.localhost\\Ubuntu\\repo', '//wsl$/ubuntu/repo/', '//wsl.localhost/UBUNTU/repo']
  ])(
    'waits for an existing install and rejects later equivalent-path installs, %s',
    async (initial, removing, later) => {
      const finishInstall = beginWatcherInstall(initial)
      const removal = acquireWatcherRemovalGate(removing)
      let ready = false
      void removal.ready.then(() => {
        ready = true
      })

      await Promise.resolve()
      expect(ready).toBe(false)
      expect(() => beginWatcherInstall(later)).toThrow(WatcherRemovalInProgressError)

      finishInstall()
      await removal.ready
      removal.release()

      const finishLaterInstall = beginWatcherInstall(initial)
      finishLaterInstall()
    }
  )

  it('drains accepted local aliases without applying local aliases to SSH roots', async () => {
    const canonical = worktreePaths.canonicalWorktreePath
    const comparison = vi
      .spyOn(worktreePaths, 'canonicalWorktreePath')
      .mockImplementation((value) => canonical(value, 'darwin'))
    const old = beginWatcherInstall('/tmp/alias-owner/nested')
    const removal = acquireWatcherRemovalGate('/private/tmp/alias-owner')
    const remote = acquireWatcherRemovalGate('/private/tmp/alias-owner', 'ssh-a')
    try {
      let ready = false
      void removal.ready.then(() => {
        ready = true
      })
      await Promise.resolve()
      expect(ready).toBe(false)
      expect(() => beginWatcherInstall('/tmp/alias-owner/late')).toThrow(
        WatcherRemovalInProgressError
      )
      expect(() => beginTerminalInstall('/tmp/alias-owner')).toThrow(TerminalRemovalInProgressError)
      expect(() => acquireWatcherRemovalGate('/tmp/alias-owner/nested')).toThrow(
        'Worktree deletion already in progress'
      )
      const remoteTmp = beginWatcherInstall('/tmp/alias-owner', 'ssh-a')
      const otherHost = beginWatcherInstall('/private/tmp/alias-owner', 'ssh-b')
      expect(() => beginWatcherInstall('/private/tmp/alias-owner', 'ssh-a')).toThrow(
        WatcherRemovalInProgressError
      )
      remoteTmp()
      otherHost()
      removal.abandonPendingInstalls()
      await removal.ready
      expect(old.isCurrent()).toBe(false)
    } finally {
      old()
      removal.release()
      remote.release()
      comparison.mockRestore()
    }
    const fresh = beginWatcherInstall('/tmp/alias-owner/nested')
    old()
    expect(old.isCurrent()).toBe(false)
    expect(fresh.isCurrent()).toBe(true)
    fresh()
  })

  it('drops abandoned install fences so a later removal is not fenced by a wedged install', async () => {
    beginWatcherInstall('/repo/nested')
    const removal = acquireWatcherRemovalGate('/repo')
    let ready = false
    void removal.ready.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    removal.abandonPendingInstalls()
    await removal.ready
    removal.release()

    const retry = acquireWatcherRemovalGate('/repo')
    await retry.ready
    retry.release()
  })

  it('keeps a fresh install fenced after an unrelated install was abandoned', async () => {
    const wedged = beginWatcherInstall('/repo')
    const removal = acquireWatcherRemovalGate('/repo')
    removal.abandonPendingInstalls()
    removal.release()
    // A wedged predecessor finishing late must not release a successor's install fence.
    const finishFresh = beginWatcherInstall('/repo')
    wedged()

    const retry = acquireWatcherRemovalGate('/repo')
    let ready = false
    void retry.ready.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    finishFresh()
    await retry.ready
    retry.release()
  })

  it('scopes identical roots to their execution host', async () => {
    const removal = acquireWatcherRemovalGate('/repo', 'ssh-a')
    await removal.ready

    const finishOtherHostInstall = beginWatcherInstall('/repo', 'ssh-b')
    expect(() => beginWatcherInstall('/repo', 'ssh-a')).toThrow(WatcherRemovalInProgressError)

    finishOtherHostInstall()
    removal.release()
  })

  it('rejects a second destructive owner across removal entry points', () => {
    const removal = acquireWatcherRemovalGate('/repo')

    expect(() => acquireWatcherRemovalGate('/repo')).toThrow(
      'Worktree deletion already in progress'
    )

    removal.release()
    const retry = acquireWatcherRemovalGate('/repo')
    retry.release()
  })

  it('waits for an existing terminal spawn and rejects later same-host spawns', async () => {
    const finishSpawn = beginTerminalInstall('/repo', 'ssh-a')
    const removal = acquireWatcherRemovalGate('/repo', 'ssh-a')
    let ready = false
    void removal.ready.then(() => {
      ready = true
    })

    await Promise.resolve()
    expect(ready).toBe(false)
    expect(() => beginTerminalInstall('/repo', 'ssh-a')).toThrow(TerminalRemovalInProgressError)

    finishSpawn()
    await removal.ready
    removal.release()
  })

  it('waits descendant installs and rejects overlapping removal roots', async () => {
    const finishSpawn = beginTerminalInstall('/repo/nested')
    const removal = acquireWatcherRemovalGate('/repo')
    let ready = false
    void removal.ready.then(() => {
      ready = true
    })

    await Promise.resolve()
    expect(ready).toBe(false)
    expect(() => beginTerminalInstall('/repo/late')).toThrow(TerminalRemovalInProgressError)
    expect(() => acquireWatcherRemovalGate('/repo/nested')).toThrow(
      'Worktree deletion already in progress'
    )

    finishSpawn()
    await removal.ready
    removal.release()
  })

  it('rejects enclosing installs while a nested root is being removed', async () => {
    const removal = acquireWatcherRemovalGate('/repo/nested')
    await removal.ready

    expect(() => beginWatcherInstall('/repo')).toThrow(WatcherRemovalInProgressError)
    expect(() => beginTerminalInstall('/repo')).toThrow(TerminalRemovalInProgressError)

    removal.release()
  })

  it('does not fence a distinct POSIX root containing a literal backslash', async () => {
    const removal = acquireWatcherRemovalGate('/srv/team\\repo')
    await removal.ready

    const finishInstall = beginWatcherInstall('/srv/team/repo')
    finishInstall()
    removal.release()
  })

  // Renderer removal handling depends on recognizing the exact shared fence-error predicate.
  it('throws fence errors the renderer recognizes as benign removal fences', async () => {
    const removal = acquireWatcherRemovalGate('/repo')
    await removal.ready

    const terminalError = (() => {
      try {
        beginTerminalInstall('/repo')
      } catch (error) {
        return error as Error
      }
      throw new Error('expected terminal install to be fenced')
    })()
    const watcherError = (() => {
      try {
        beginWatcherInstall('/repo')
      } catch (error) {
        return error as Error
      }
      throw new Error('expected watcher install to be fenced')
    })()

    expect(isWorktreeRemovalFenceError(terminalError.message)).toBe(true)
    expect(isWorktreeRemovalFenceError(watcherError.message)).toBe(true)

    removal.release()
  })
})
