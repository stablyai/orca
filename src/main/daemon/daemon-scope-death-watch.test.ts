import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProcessSpec, SpawnedProcess } from '@orca/process-host/process-spec'
import { ownFreshDaemonScope } from './daemon-cgroup-scope'
import { startDaemonScopeDeathWatch } from './daemon-scope-death-watch'

const spawnProcess = vi.fn<(spec: ProcessSpec) => SpawnedProcess>()

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

function options() {
  return {
    daemonScope: 'orca-daemon-launch-a.scope',
    spawn: spawnProcess,
    log: vi.fn()
  }
}

describe('daemon scope death watch ownership', () => {
  it('only a fresh scope the daemon is still in qualifies', () => {
    const own = (unit: string | null) => () => unit
    expect(ownFreshDaemonScope(true, 'launch-a', own('orca-daemon-launch-a.scope'))).toBe(
      'orca-daemon-launch-a.scope'
    )
    expect(ownFreshDaemonScope(false, 'launch-a', own('orca-daemon-launch-a.scope'))).toBeNull()
    expect(ownFreshDaemonScope(true, undefined, own('orca-daemon-launch-a.scope'))).toBeNull()
    for (const unit of [null, 'app-orca-123.scope', 'orca-daemon-other.scope']) {
      expect(ownFreshDaemonScope(true, 'launch-a', own(unit))).toBeNull()
    }
  })

  it('does not arm without an owned scope', () => {
    expect(startDaemonScopeDeathWatch({ ...options(), daemonScope: null })).toBeNull()
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('retains the lifetime pipe and uses the verified user bus', () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'disabled:')
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000')
    const stdin = new PassThrough()
    const child = Object.defineProperties(new ChildProcess(), {
      stdin: { value: stdin },
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() }
    })
    vi.spyOn(child, 'unref').mockImplementation(() => {})
    vi.mocked(spawnProcess).mockReturnValue(child)
    const opts = options()

    expect(startDaemonScopeDeathWatch(opts)).toBe(child)
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/sh',
        detached: true,
        args: [
          '-c',
          expect.any(String),
          'orca-daemon-scope-watch',
          String(process.pid),
          'orca-daemon-launch-a.scope'
        ],
        stdio: ['pipe', 'ignore', 'ignore'],
        env: expect.objectContaining({ XDG_RUNTIME_DIR: '/run/user/1000' })
      })
    )
    expect(vi.mocked(spawnProcess).mock.calls[0][0].env).not.toHaveProperty(
      'DBUS_SESSION_BUS_ADDRESS'
    )
    expect(stdin.writableEnded).toBe(false)
    expect(child.unref).toHaveBeenCalledOnce()

    stdin.emit('error', new Error('pipe failed'))
    child.emit('error', new Error('spawn failed'))
    child.emit('exit', 1, null)
    expect(stdin.destroyed).toBe(true)
    expect(opts.log.mock.calls.map(([event]) => event)).toEqual([
      'scope-death-watch-pipe-error',
      'scope-death-watch-error',
      'scope-death-watch-exit'
    ])
  })

  it('logs spawn failure without crashing the daemon', () => {
    vi.mocked(spawnProcess).mockImplementation(() => {
      throw new Error('unavailable')
    })
    const opts = options()
    expect(startDaemonScopeDeathWatch(opts)).toBeNull()
    expect(opts.log).toHaveBeenCalledWith('scope-death-watch-error', {
      message: 'Error: unavailable'
    })
  })
})
