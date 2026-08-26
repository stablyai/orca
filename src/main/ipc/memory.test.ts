import { beforeEach, describe, expect, it, vi } from 'vitest'

const { collectMemorySnapshotMock, callRuntimeEnvironmentMock, handleMock, getPathMock } =
  vi.hoisted(() => ({
    collectMemorySnapshotMock: vi.fn(),
    callRuntimeEnvironmentMock: vi.fn(),
    handleMock: vi.fn(),
    getPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock }
}))
vi.mock('../memory/collector', () => ({ collectMemorySnapshot: collectMemorySnapshotMock }))
vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import type { Store } from '../persistence'
import { registerMemoryHandlers, type MemorySnapshotRequest } from './memory'

type Handler = (event: unknown, request?: MemorySnapshotRequest) => Promise<unknown>

function handler(): Handler {
  handleMock.mockReset()
  registerMemoryHandlers({} as Store)
  const entry = handleMock.mock.calls.find((call) => call[0] === 'memory:getSnapshot')
  expect(entry).toBeTruthy()
  return entry![1] as Handler
}

const remotePayload = { worktrees: [], totalMemory: 1234 }

describe('memory:getSnapshot', () => {
  beforeEach(() => {
    collectMemorySnapshotMock.mockReset()
    callRuntimeEnvironmentMock.mockReset()
    collectMemorySnapshotMock.mockResolvedValue({ collectedAt: 1, worktrees: [] })
  })

  it('samples locally when no host is named', async () => {
    await expect(handler()(null)).resolves.toEqual({ collectedAt: 1, worktrees: [] })
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('samples locally for an explicit local host', async () => {
    await handler()(null, { executionHostId: 'local' })
    expect(collectMemorySnapshotMock).toHaveBeenCalledTimes(1)
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('proxies diagnostics.memory to the named runtime host', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({ ok: true, result: remotePayload })
    const snapshot = await handler()(null, { executionHostId: 'runtime:env-lxc1' })
    expect(callRuntimeEnvironmentMock.mock.calls[0].slice(0, 4)).toEqual([
      '/tmp/orca-user-data',
      'env-lxc1',
      'diagnostics.memory',
      null
    ])
    expect(snapshot).toMatchObject({ totalMemory: 1234 })
    expect(collectMemorySnapshotMock).not.toHaveBeenCalled()
  })

  it('decodes a runtime host id that was percent-encoded', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({ ok: true, result: remotePayload })
    await handler()(null, { executionHostId: 'runtime:env%2Fone' })
    expect(callRuntimeEnvironmentMock.mock.calls[0][1]).toBe('env/one')
  })

  // Why: falling back to local numbers under a remote label would report an
  // unreachable machine as though we had measured it.
  it('rejects instead of falling back when the runtime call fails', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({
      ok: false,
      error: { code: 'runtime_unavailable', message: 'offline' }
    })
    await expect(handler()(null, { executionHostId: 'runtime:env-lxc1' })).rejects.toThrow(
      'offline'
    )
    expect(collectMemorySnapshotMock).not.toHaveBeenCalled()
  })

  it('rejects when a host answers with something that is not a snapshot', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({ ok: true, result: { nope: true } })
    await expect(handler()(null, { executionHostId: 'runtime:env-lxc1' })).rejects.toThrow(
      'runtime_snapshot_unsupported'
    )
  })

  // Why: the per-environment call queue serializes requests, so one call that never
  // settles would wedge every later poll and freeze a stale reading on screen.
  it('gives up on a transport that never settles', async () => {
    vi.useFakeTimers()
    try {
      callRuntimeEnvironmentMock.mockReturnValue(new Promise(() => {}))
      const pending = handler()(null, { executionHostId: 'runtime:env-lxc1' })
      const assertion = expect(pending).rejects.toThrow('runtime_unreachable')
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the deadline is an outer bound, not a replacement for the transport's own
  // timeout — a healthy-but-slow host must still answer on its normal path.
  it('leaves the transport timeout at its default', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({ ok: true, result: remotePayload })
    await handler()(null, { executionHostId: 'runtime:env-lxc1' })
    expect(callRuntimeEnvironmentMock.mock.calls[0][4]).toBeUndefined()
  })

  // Why: rejecting this caller is not enough. Calls to one environment are
  // serialized, so a request left running would wedge every later poll behind it.
  it('aborts the transport when the deadline expires', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      callRuntimeEnvironmentMock.mockImplementation(
        (..._args: unknown[]) =>
          new Promise(() => {
            signal = (_args[7] as { signal?: AbortSignal } | undefined)?.signal
          })
      )
      const pending = handler()(null, { executionHostId: 'runtime:env-lxc1' })
      const assertion = expect(pending).rejects.toThrow('runtime_unreachable')
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an SSH host rather than answering with local numbers', async () => {
    await expect(handler()(null, { executionHostId: 'ssh:box' })).rejects.toThrow(
      'resource_host_unsupported'
    )
    expect(collectMemorySnapshotMock).not.toHaveBeenCalled()
  })
})
