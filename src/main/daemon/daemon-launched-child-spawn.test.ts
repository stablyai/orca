import { afterEach, describe, expect, it, vi } from 'vitest'
import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { spawnDaemonChildProcess } from './daemon-launched-child-spawn'

const { spawn, fork } = vi.hoisted(() => ({ spawn: vi.fn(), fork: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawn }))
vi.mock('../../shared/child-process/fork-process', () => ({ forkProcess: fork }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.0.0' })
}))
vi.mock('./daemon-launch-paths', () => ({ daemonLogArgs: () => [] }))

const options = {
  entryPath: '/app/daemon-entry.js',
  forkEntryPath: '/app/daemon-entry.js',
  userDataPath: '/tmp/orca',
  socketPath: '/tmp/orca/daemon.sock',
  tokenPath: '/tmp/orca/token',
  pidPath: '/tmp/orca/pid',
  launchNonce: 'scope-owner',
  macosLoginSessionWatch: false
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('daemon launch scope ownership', () => {
  it('only arms lifetime cleanup through the private scope launcher', () => {
    spawnDaemonChildProcess(options, true)
    expect(fork).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'systemd-run',
        args: expect.arrayContaining([
          '--scope',
          '--unit=orca-daemon-scope-owner.scope',
          '--property=TimeoutStopSec=5s',
          '--fresh-daemon-scope'
        ])
      })
    )
  })

  it('does not arm cleanup on the direct launch fallback', () => {
    spawnDaemonChildProcess(options, false)
    expect(spawn).not.toHaveBeenCalled()
    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.not.arrayContaining(['--fresh-daemon-scope'])
      })
    )
  })
})

describe('headless Bun daemon launch', () => {
  function useBun(): void {
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, bun: '1.4.2' })
    vi.stubEnv('NODE_OPTIONS', '--require=untrusted.js')
    vi.stubEnv('NODE_PATH', '/untrusted')
    vi.stubEnv('BUN_OPTIONS', '--preload=untrusted.js')
  }

  it('isolates scoped Bun launches before the daemon entry', () => {
    useBun()
    spawnDaemonChildProcess(options, true)
    const call = spawn.mock.calls[0][0]
    const executableIndex = call.args.indexOf(process.execPath)
    expect(call.args.slice(executableIndex + 1, executableIndex + 5)).toEqual([
      ...bunOwnedRuntimeArgs(),
      options.forkEntryPath
    ])
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS']) {
      expect(call.env[key]).toBeUndefined()
    }
  })

  it('scrubs direct Bun forks while preserving the selected ConPTY library', () => {
    useBun()
    vi.stubEnv('BUN_CONPTY_LIBRARY', '/verified/conpty.dll')
    spawnDaemonChildProcess(options, false)
    expect(fork.mock.calls[0][0].env).toEqual(
      expect.objectContaining({
        BUN_CONPTY_LIBRARY: '/verified/conpty.dll',
        ORCA_USER_DATA_PATH: options.userDataPath
      })
    )
    expect(fork.mock.calls[0][0].env.NODE_OPTIONS).toBeUndefined()
  })

  it('preserves an explicitly selected Node executable', () => {
    useBun()
    spawnDaemonChildProcess({ ...options, relocatedExecPath: '/alternate/node' }, true)
    const call = spawn.mock.calls[0][0]
    expect(call.args).not.toContain('--no-install')
    expect(call.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
