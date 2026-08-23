import { describe, expect, it, vi } from 'vitest'
import {
  createWindowQuitLifecycle,
  finishWindowSessionPersistenceForQuit
} from './window-quit-lifecycle'

describe('window quit lifecycle', () => {
  it('fences transfers before freezing session retirement and later side effects', () => {
    const calls: string[] = []
    const lifecycle = createWindowQuitLifecycle({
      fenceTransfers: () => {
        calls.push('fence-transfers')
        return Promise.resolve()
      },
      freezeSessions: () => calls.push('freeze-sessions'),
      resumeTransfers: vi.fn(),
      resumeSessions: vi.fn()
    })

    expect(lifecycle.isActive()).toBe(false)
    lifecycle.begin()
    expect(lifecycle.isActive()).toBe(true)
    calls.push('later-side-effect')

    expect(calls).toEqual(['fence-transfers', 'freeze-sessions', 'later-side-effect'])
  })

  it('is idempotent until abort then resumes only the quit-owned fences', () => {
    const fenceTransfers = vi.fn(() => Promise.resolve())
    const freezeSessions = vi.fn()
    const resumeTransfers = vi.fn()
    const resumeSessions = vi.fn()
    const lifecycle = createWindowQuitLifecycle({
      fenceTransfers,
      freezeSessions,
      resumeTransfers,
      resumeSessions
    })

    expect(lifecycle.begin()).toBe(lifecycle.begin())
    expect(fenceTransfers).toHaveBeenCalledOnce()
    expect(freezeSessions).toHaveBeenCalledOnce()

    lifecycle.abort()
    expect(lifecycle.isActive()).toBe(false)
    expect(resumeTransfers).toHaveBeenCalledOnce()
    expect(resumeSessions).toHaveBeenCalledOnce()

    lifecycle.begin()
    expect(fenceTransfers).toHaveBeenCalledTimes(2)
    expect(freezeSessions).toHaveBeenCalledTimes(2)
  })

  it('stages and flushes the rollback snapshot only after the transfer fence settles', async () => {
    let settleTransfer!: () => void
    const transferFence = new Promise<void>((resolve) => {
      settleTransfer = resolve
    })
    const calls: string[] = []
    let sessionState = 'before-rollback'
    let stagedState = ''
    let durableState = ''

    const completed = finishWindowSessionPersistenceForQuit({
      transferFence,
      stageSessions: () => {
        calls.push('stage')
        stagedState = sessionState
      },
      beginSshShutdown: () => {
        calls.push('ssh-shutdown')
        return Promise.resolve()
      },
      killAllPty: () => calls.push('kill-pty'),
      flushStore: () => {
        calls.push('flush')
        durableState = stagedState
        return Promise.resolve()
      }
    })

    expect(calls).toEqual([])
    sessionState = 'after-rollback'
    settleTransfer()
    await completed

    expect(calls).toEqual(['stage', 'ssh-shutdown', 'kill-pty', 'flush'])
    expect(durableState).toBe('after-rollback')
  })

  it('continues shutdown and reports a synchronous staging failure', async () => {
    const calls: string[] = []
    const stageError = new Error('stage failed')

    const completed = finishWindowSessionPersistenceForQuit({
      transferFence: Promise.resolve(),
      stageSessions: () => {
        calls.push('stage')
        throw stageError
      },
      beginSshShutdown: () => {
        calls.push('ssh-shutdown')
        return Promise.resolve()
      },
      killAllPty: () => calls.push('kill-pty'),
      flushStore: () => {
        calls.push('flush')
        return Promise.resolve()
      }
    })

    await expect(completed).rejects.toBe(stageError)
    expect(calls).toEqual(['stage', 'ssh-shutdown', 'kill-pty', 'flush'])
  })
})
