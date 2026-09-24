import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec, SpawnedProcess } from '../../shared/child-process/run-process'
import { startDaemonScopeDeathWatch } from './daemon-scope-death-watch'

const spawnProcess = vi.fn<(spec: ProcessSpec) => SpawnedProcess>()

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

function options() {
  return {
    freshScope: true,
    launchNonce: 'launch-a',
    platform: 'linux' as const,
    spawn: spawnProcess,
    detectScope: () => 'orca-daemon-launch-a.scope',
    log: vi.fn()
  }
}

describe('daemon scope death watch ownership', () => {
  it.each(['darwin', 'win32'] as const)('never spawns on %s', (platform) => {
    expect(startDaemonScopeDeathWatch({ ...options(), platform })).toBeNull()
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('does not arm an adopted scope even when its nonce matches', () => {
    expect(startDaemonScopeDeathWatch({ ...options(), freshScope: false })).toBeNull()
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it.each([null, 'app-orca-123.scope', 'orca-daemon-other.scope'])(
    'rejects unverified ownership of %s',
    (unit) => {
      expect(startDaemonScopeDeathWatch({ ...options(), detectScope: () => unit })).toBeNull()
      expect(spawnProcess).not.toHaveBeenCalled()
    }
  )

  it('does not arm without the launcher nonce', () => {
    expect(startDaemonScopeDeathWatch({ ...options(), launchNonce: undefined })).toBeNull()
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('retains the lifetime pipe and uses the verified user bus', () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'disabled:')
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000')
    const child = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
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
    expect(child.stdin.writableEnded).toBe(false)
    expect(child.unref).toHaveBeenCalledOnce()

    child.stdin.emit('error', new Error('pipe failed'))
    child.emit('error', new Error('spawn failed'))
    child.emit('exit', 1, null)
    expect(child.stdin.destroyed).toBe(true)
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
