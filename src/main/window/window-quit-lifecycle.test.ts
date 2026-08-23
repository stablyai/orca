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
      },
      onError: vi.fn()
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
      },
      onError: vi.fn()
    })

    await expect(completed).rejects.toBe(stageError)
    expect(calls).toEqual(['stage', 'ssh-shutdown', 'kill-pty', 'flush'])
  })

  it('continues kill and flush after synchronous SSH shutdown failure', async () => {
    const calls: string[] = []
    const sshError = new Error('ssh failed')
    let stagedState = ''
    let durableState = ''

    const completed = finishWindowSessionPersistenceForQuit({
      transferFence: Promise.resolve(),
      stageSessions: () => {
        calls.push('stage')
        stagedState = 'rollback-snapshot'
      },
      beginSshShutdown: () => {
        calls.push('ssh-shutdown')
        throw sshError
      },
      killAllPty: () => calls.push('kill-pty'),
      flushStore: () => {
        calls.push('flush')
        durableState = stagedState
        return Promise.resolve()
      },
      onError: vi.fn()
    })

    await expect(completed).rejects.toBe(sshError)
    expect(calls).toEqual(['stage', 'ssh-shutdown', 'kill-pty', 'flush'])
    expect(durableState).toBe('rollback-snapshot')
  })

  it('continues flush after synchronous PTY kill failure', async () => {
    const calls: string[] = []
    const killError = new Error('kill failed')
    let stagedState = ''
    let durableState = ''

    const completed = finishWindowSessionPersistenceForQuit({
      transferFence: Promise.resolve(),
      stageSessions: () => {
        calls.push('stage')
        stagedState = 'rollback-snapshot'
      },
      beginSshShutdown: () => {
        calls.push('ssh-shutdown')
        return Promise.resolve()
      },
      killAllPty: () => {
        calls.push('kill-pty')
        throw killError
      },
      flushStore: () => {
        calls.push('flush')
        durableState = stagedState
        return Promise.resolve()
      },
      onError: vi.fn()
    })

    await expect(completed).rejects.toBe(killError)
    expect(calls).toEqual(['stage', 'ssh-shutdown', 'kill-pty', 'flush'])
    expect(durableState).toBe('rollback-snapshot')
  })

  it('reports the first rejected teardown promise after all returned promises settle', async () => {
    const sshError = new Error('ssh rejected')
    const flushError = new Error('flush rejected')
    const calls: string[] = []

    const completed = finishWindowSessionPersistenceForQuit({
      transferFence: Promise.resolve(),
      stageSessions: () => calls.push('stage'),
      beginSshShutdown: () => {
        calls.push('ssh-shutdown')
        return Promise.reject(sshError)
      },
      killAllPty: () => calls.push('kill-pty'),
      flushStore: () => {
        calls.push('flush')
        return Promise.reject(flushError)
      },
      onError: vi.fn()
    })

    await expect(completed).rejects.toBe(sshError)
    expect(calls).toEqual(['stage', 'ssh-shutdown', 'kill-pty', 'flush'])
  })

  it('reports a synchronous store flush failure after prior teardown steps run once', async () => {
    const flushError = new Error('flush failed')
    const calls: string[] = []

    const completed = finishWindowSessionPersistenceForQuit({
      transferFence: Promise.resolve(),
      stageSessions: () => calls.push('stage'),
      beginSshShutdown: () => {
        calls.push('ssh-shutdown')
        return Promise.resolve()
      },
      killAllPty: () => calls.push('kill-pty'),
      flushStore: () => {
        calls.push('flush')
        throw flushError
      },
      onError: vi.fn()
    })

    await expect(completed).rejects.toBe(flushError)
    expect(calls).toEqual(['stage', 'ssh-shutdown', 'kill-pty', 'flush'])
  })

  it('reports every failed persistence step to the production error sink', async () => {
    const transferError = new Error('transfer failed')
    const stageError = new Error('stage failed')
    const sshError = new Error('ssh failed')
    const killError = new Error('kill failed')
    const flushError = new Error('flush failed')
    const reported: [string, unknown][] = []
    const options = {
      transferFence: Promise.reject(transferError),
      stageSessions: () => {
        throw stageError
      },
      beginSshShutdown: () => Promise.reject(sshError),
      killAllPty: () => {
        throw killError
      },
      flushStore: () => Promise.reject(flushError),
      onError: (step: string, error: unknown) => reported.push([step, error])
    }

    await expect(finishWindowSessionPersistenceForQuit(options)).rejects.toBe(transferError)
    expect(reported).toHaveLength(5)
    expect(reported).toEqual(
      expect.arrayContaining([
        ['transfer-fence', transferError],
        ['stage-sessions', stageError],
        ['ssh-shutdown', sshError],
        ['kill-pty', killError],
        ['store-flush', flushError]
      ])
    )
  })

  it('reports a settled failure while another teardown promise remains pending', async () => {
    const sshShutdown = new Promise<void>(() => {})
    const flushError = new Error('flush failed')
    let rejectFlush!: (error: Error) => void
    let markFlushStarted!: () => void
    const flushStarted = new Promise<void>((resolve) => {
      markFlushStarted = resolve
    })
    const flushStore = new Promise<void>((_resolve, reject) => {
      rejectFlush = reject
    })
    const onError = vi.fn()

    const completed = finishWindowSessionPersistenceForQuit({
      transferFence: Promise.resolve(),
      stageSessions: vi.fn(),
      beginSshShutdown: () => sshShutdown,
      killAllPty: vi.fn(),
      flushStore: () => {
        markFlushStarted()
        return flushStore
      },
      onError
    })

    await flushStarted
    rejectFlush(flushError)
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith('store-flush', flushError)
    void completed
  })
})
