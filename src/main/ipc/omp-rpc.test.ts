import { describe, expect, it, vi, beforeEach } from 'vitest'
import type {
  OmpRpcGetCommandsResult,
  OmpRpcRunLocalCommandResult
} from '../../shared/omp-rpc-ipc-contract'

const {
  handle,
  pool,
  createOmpRpcProbePool,
  isCommandOnLocalPath,
  resolveCommandOnLocalPath,
  hydrateShellPath
} = vi.hoisted(
  () => {
    const pool = {
      getCommands: vi.fn(),
      runLocalCommand: vi.fn(),
      dispose: vi.fn(() => Promise.resolve())
    }
    return {
      handle: vi.fn(),
      pool,
      createOmpRpcProbePool: vi.fn(() => pool),
      isCommandOnLocalPath: vi.fn(),
      resolveCommandOnLocalPath: vi.fn(),
      hydrateShellPath: vi.fn()
    }
  }
)

vi.mock('electron', () => ({ ipcMain: { handle } }))
vi.mock('./omp-rpc-probe-pool', () => ({ createOmpRpcProbePool }))
vi.mock('./command-path-resolver', () => ({ isCommandOnLocalPath, resolveCommandOnLocalPath }))
vi.mock('./agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: hydrateShellPath
}))

import {
  disposeOmpRpcProbes,
  registerOmpRpcHandlers,
  resetOmpRpcProbeShutdownForTests,
  resolveOmpRpcLaunch
} from './omp-rpc'

function invoke(channel: string, args?: unknown): Promise<unknown> {
  const handler = handle.mock.calls.find(([name]) => name === channel)?.[1] as (
    event: unknown,
    args?: unknown
  ) => Promise<unknown>
  return handler({}, args)
}

describe('OMP RPC IPC handlers', () => {
  beforeEach(() => {
    // Drop any pool a previous test built BEFORE clearing mocks, so its teardown
    // dispose is not counted against the next test.
    void disposeOmpRpcProbes()
    resetOmpRpcProbeShutdownForTests()
    vi.clearAllMocks()
    hydrateShellPath.mockResolvedValue(undefined)
  })

  it('registers both channels', () => {
    registerOmpRpcHandlers()
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'ompRpc:getCommands',
      'ompRpc:runLocalCommand'
    ])
  })

  it('preserves wrapper and agent arguments from an OMP command override', async () => {
    isCommandOnLocalPath.mockResolvedValue(true)

    await expect(resolveOmpRpcLaunch('env omp --profile work')).resolves.toEqual({
      executablePath: 'env',
      commandArgs: ['omp', '--profile', 'work']
    })
  })

  it('settles quit teardown on the pool disposal, or immediately with no pool', async () => {
    await expect(disposeOmpRpcProbes()).resolves.toBeUndefined()
    expect(pool.dispose).not.toHaveBeenCalled()
    resetOmpRpcProbeShutdownForTests()

    isCommandOnLocalPath.mockResolvedValue(true)
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    let releaseDisposal = (): void => {}
    pool.dispose.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseDisposal = resolve
      })
    )
    let settled = false
    const teardown = disposeOmpRpcProbes().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseDisposal()
    await teardown
    expect(settled).toBe(true)
  })

  it('refuses queued probes after shutdown begins instead of creating an unowned pool', async () => {
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    let finishDisposal = (): void => {}
    pool.dispose.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDisposal = resolve
      })
    )

    const shutdown = disposeOmpRpcProbes()

    await expect(invoke('ompRpc:getCommands', { cwd: '/work/b' })).resolves.toEqual({
      ok: false,
      errorCode: 'request-failed'
    })
    expect(createOmpRpcProbePool).toHaveBeenCalledTimes(1)
    finishDisposal()
    await shutdown
  })

  it('forwards a catalog read to the pool', async () => {
    const commands: OmpRpcGetCommandsResult = { ok: true, commands: [{ name: 'usage' }] }
    pool.getCommands.mockResolvedValue(commands)
    isCommandOnLocalPath.mockResolvedValue(true)
    registerOmpRpcHandlers()

    await expect(invoke('ompRpc:getCommands', { cwd: '/work/a' })).resolves.toEqual(commands)
    expect(pool.getCommands).toHaveBeenCalledWith('/work/a')
  })

  it('forwards a local command and its allowlist verdict from the pool', async () => {
    const denied: OmpRpcRunLocalCommandResult = { ok: false, errorCode: 'not-allowed' }
    pool.runLocalCommand.mockResolvedValue(denied)
    registerOmpRpcHandlers()

    await expect(
      invoke('ompRpc:runLocalCommand', { cwd: '/work/a', command: '/compact' })
    ).resolves.toEqual(denied)
    expect(pool.runLocalCommand).toHaveBeenCalledWith('/work/a', '/compact')
  })

  it('fails closed on a missing cwd without touching the pool', async () => {
    registerOmpRpcHandlers()
    await expect(invoke('ompRpc:getCommands', { cwd: '   ' })).resolves.toEqual({
      ok: false,
      errorCode: 'executable-not-found'
    })
    await expect(invoke('ompRpc:runLocalCommand', {})).resolves.toEqual({
      ok: false,
      errorCode: 'executable-not-found'
    })
    expect(pool.getCommands).not.toHaveBeenCalled()
    expect(pool.runLocalCommand).not.toHaveBeenCalled()
  })

  it('never throws across IPC when the pool rejects', async () => {
    pool.getCommands.mockRejectedValue(new Error('boom'))
    pool.runLocalCommand.mockRejectedValue(new Error('boom'))
    registerOmpRpcHandlers()

    await expect(invoke('ompRpc:getCommands', { cwd: '/work/a' })).resolves.toEqual({
      ok: false,
      errorCode: 'request-failed'
    })
    await expect(
      invoke('ompRpc:runLocalCommand', { cwd: '/work/a', command: '/usage' })
    ).resolves.toEqual({ ok: false, errorCode: 'request-failed' })
  })

  it('builds the pool lazily, on the first request rather than at registration', async () => {
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    expect(createOmpRpcProbePool).not.toHaveBeenCalled()

    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    expect(createOmpRpcProbePool).toHaveBeenCalledTimes(1)
  })

  it('resolves the omp binary from PATH, hydrating the login shell PATH only on a miss', async () => {
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    const resolve = (
      createOmpRpcProbePool.mock.calls as unknown as [
        { resolveExecutablePath: () => Promise<{ executablePath: string } | null> }
      ][]
    )[0][0].resolveExecutablePath

    isCommandOnLocalPath.mockResolvedValueOnce(true)
    await expect(resolve()).resolves.toEqual({ executablePath: 'omp' })
    expect(hydrateShellPath).not.toHaveBeenCalled()

    // A GUI-launched app can miss ~/.local/bin until the login shell PATH loads.
    isCommandOnLocalPath.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(resolve()).resolves.toEqual({ executablePath: 'omp' })
    expect(hydrateShellPath).toHaveBeenCalledTimes(1)
    // Exhaustive miss behavior (forced re-hydration, well-known installer
    // locations, final null) is owned by omp-rpc-executable-resolver.test.ts —
    // asserting it here would touch the real filesystem.
  })

  it('shares one pool across workspaces and disposes it on shutdown', async () => {
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    await invoke('ompRpc:getCommands', { cwd: '/work/b' })
    expect(createOmpRpcProbePool).toHaveBeenCalledTimes(1)

    disposeOmpRpcProbes()
    expect(pool.dispose).toHaveBeenCalledTimes(1)
  })
})
