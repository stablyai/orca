import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawn }))

import { launchBunCli } from './cli-bun-launcher'

const originalExitCode = process.exitCode
afterEach(() => {
  process.exitCode = originalExitCode
  vi.clearAllMocks()
})

describe.skipIf(process.platform === 'win32')('CLI launcher startup signals', () => {
  it('captures a signal before spawning returns and forwards it once', () => {
    const listeners = process.listenerCount('SIGINT')
    const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() })
    spawn.mockImplementationOnce(() => {
      expect(process.listenerCount('SIGINT')).toBe(listeners + 1)
      process.emit('SIGINT', 'SIGINT')
      expect(child.kill).not.toHaveBeenCalled()
      return child
    })

    try {
      launchBunCli('/bun', '/cli.js', ['status'])
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['--no-env-file', '--config=/dev/null', '--no-install', '/cli.js', 'status']
        })
      )
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGINT')
    } finally {
      child.emit('exit', 0, null)
    }
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  it('removes preinstalled signal handlers when spawning throws', () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP', 'SIGCONT'] as const
    const counts = signals.map((signal) => process.listenerCount(signal))
    const failure = new Error('spawn failed')
    spawn.mockImplementationOnce(() => {
      throw failure
    })

    expect(() => launchBunCli('/bun', '/cli.js', [])).toThrow(failure)
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(counts)
  })
})
