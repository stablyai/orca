import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnLocalPty } from './local-pty-spawn'
import { cancelPendingLocalPtySpawns } from './local-pty-spawn-state'
import { pendingLocalPtySpawns, ptyProcesses } from './local-pty-provider-state'

const { spawn, activate, destroy } = vi.hoisted(() => ({
  spawn: vi.fn(),
  activate: vi.fn(),
  destroy: vi.fn()
}))
vi.mock('./local-pty-runtime-spawn', () => ({ loadLocalPtyRuntimeSpawn: async () => spawn }))
vi.mock('./macos-tcc-login-shell', () => ({ prepareMacosTccLoginShell: async () => {} }))
vi.mock('./local-pty-finalize-environment', () => ({
  finalizeLocalPtySpawnEnvironment: () => null
}))
vi.mock('./local-pty-spawn-environment', () => ({
  buildLocalPtySpawnEnvironment: () => ({}),
  enforceLocalPtySpawnEnvironmentOverrides() {}
}))
vi.mock('./local-pty-launch-plan', () => ({
  DeferredLocalPtyLaunchPlan: class {},
  createLocalPtyLaunchPlan: () => ({
    shellPath: '/bin/sh',
    shellArgs: [],
    effectiveCwd: '/tmp',
    cwd: '/tmp',
    windowsFallbackAttempts: []
  })
}))
vi.mock('./local-pty-session-activation', () => ({ activateLocalPtySession: activate }))
vi.mock('./local-pty-termination', () => ({ destroyPtyProcess: destroy }))

function createProcess() {
  return {
    pid: 12345,
    process: '/bin/sh',
    cols: 80,
    rows: 24,
    handleFlowControl: false,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    clear() {},
    pause() {},
    resume() {},
    resize: vi.fn(),
    kill: vi.fn()
  }
}

function start(id = 'pending-bun-shell') {
  return spawnLocalPty({ sessionId: id, cols: 80, rows: 24 }, () => ({}))
}

beforeEach(() => {
  vi.clearAllMocks()
  activate.mockImplementation(({ id, proc }) => {
    ptyProcesses.set(id, proc)
    return { id, pid: proc.pid }
  })
})
afterEach(() => {
  ptyProcesses.clear()
  expect(pendingLocalPtySpawns.size).toBe(0)
})

describe('local PTY native spawn admission', () => {
  it('aborts a pending receipt when the requesting client disconnects', async () => {
    const controller = new AbortController()
    spawn.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const result = spawnLocalPty(
      { sessionId: 'disconnected-shell', cols: 80, rows: 24, signal: controller.signal },
      () => ({})
    )
    const rejected = expect(result).rejects.toThrow('client disconnected')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    controller.abort(new Error('client disconnected'))
    await rejected
    expect(activate).not.toHaveBeenCalled()
  })

  it('reserves the same session until a delayed shell receipt is activated', async () => {
    const proc = createProcess()
    let release!: () => void
    spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ process: proc, shellPath: '/bin/sh' })
        })
    )
    const first = start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const second = start()
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawn).toHaveBeenCalledOnce()
    release()
    expect(await first).toEqual({ id: 'pending-bun-shell', pid: proc.pid })
    expect(await second).toMatchObject({ id: 'pending-bun-shell', pid: proc.pid, isReattach: true })
    expect(activate).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('aborts a pending receipt on shutdown and cancels queued same-session launches', async () => {
    spawn.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const first = start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const second = start()
    const results = Promise.allSettled([first, second])
    cancelPendingLocalPtySpawns('pending-bun-shell')
    expect(await results).toEqual([
      { status: 'rejected', reason: new Error('PTY spawn canceled: pending-bun-shell') },
      { status: 'rejected', reason: new Error('PTY spawn canceled: pending-bun-shell') }
    ])
    expect(spawn).toHaveBeenCalledOnce()
    expect(activate).not.toHaveBeenCalled()
  })

  it('cleans a confirmed process when shutdown races the receipt continuation', async () => {
    const proc = createProcess()
    let release!: () => void
    spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ process: proc, shellPath: '/bin/sh' })
        })
    )
    const first = start()
    const rejected = expect(first).rejects.toThrow('PTY spawn canceled: pending-bun-shell')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    release()
    cancelPendingLocalPtySpawns('pending-bun-shell')
    await rejected
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(destroy).toHaveBeenCalledWith(proc)
    expect(activate).not.toHaveBeenCalled()
  })
})
