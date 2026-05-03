import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

import { killAllProcessesForWorktree } from './worktree-teardown'
import type { IPtyProvider } from '../providers/types'

function createProviderStub(
  listProcesses: () => Promise<{ id: string; cwd: string; title: string }[]>
): IPtyProvider {
  return {
    spawn: vi.fn(),
    attach: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    listProcesses: vi.fn(listProcesses),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    onData: vi.fn().mockReturnValue(() => {}),
    onReplay: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {})
  } as unknown as IPtyProvider
}

describe('killAllProcessesForWorktree', () => {
  beforeEach(() => {
    listRegisteredPtysMock.mockReset()
  })

  it('reaches daemon sessions and registry entries without a runtime', async () => {
    // Simulate headless-CLI: no renderer, so `runtime` is undefined.
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@abcd1234', cwd: '/tmp/w1', title: 'shell' },
      { id: 'w2@@efef5678', cwd: '/tmp/w2', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1-registry-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 },
      { ptyId: 'w2-registry-2', worktreeId: 'w2', sessionId: null, paneKey: null, pid: 101 }
    ])

    const result = await killAllProcessesForWorktree('w1', { localProvider })

    expect(result.runtimeStopped).toBe(0)
    expect(result.providerStopped).toBe(1)
    expect(result.registryStopped).toBe(1)

    expect(localProvider.shutdown).toHaveBeenCalledWith('w1@@abcd1234', true)
    expect(localProvider.shutdown).toHaveBeenCalledWith('w1-registry-1', true)
    expect(localProvider.shutdown).not.toHaveBeenCalledWith('w2@@efef5678', true)
    expect(localProvider.shutdown).not.toHaveBeenCalledWith('w2-registry-2', true)
  })

  it('skips the daemon prefix sweep safely when the provider uses numeric ids', async () => {
    // LocalPtyProvider shape: numeric ids that cannot match `${worktreeId}@@`.
    const localProvider = createProviderStub(async () => [
      { id: '1', cwd: '/tmp/w1', title: 'shell' },
      { id: '2', cwd: '/tmp/w2', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: '1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 200 }
    ])

    const result = await killAllProcessesForWorktree('w1', { localProvider })

    // Prefix sweep must kill nothing; registry sweep must still fire.
    expect(result.providerStopped).toBe(0)
    expect(result.registryStopped).toBe(1)
    expect(localProvider.shutdown).toHaveBeenCalledWith('1', true)
    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
  })

  it('best-effort: swallows errors from listProcesses and shutdown', async () => {
    const localProvider = createProviderStub(() => Promise.reject(new Error('boom')))
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'x', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 10 }
    ])
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('already dead')
    )

    const result = await killAllProcessesForWorktree('w1', { localProvider })

    // listProcesses rejected → provider sweep returns 0; registry shutdown
    // rejected → counted as not-killed (registry sweep currently swallows).
    expect(result.providerStopped).toBe(0)
    expect(result.registryStopped).toBe(0)
  })

  it('does not carry state between successive calls with distinct providers', async () => {
    // Guards against a future refactor that memoises provider or registry
    // reads inside the helper.
    const providerA = createProviderStub(async () => [
      { id: 'w1@@aaaa', cwd: '/tmp', title: 'shell' }
    ])
    const providerB = createProviderStub(async () => [
      { id: 'w1@@bbbb', cwd: '/tmp', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([])

    const r1 = await killAllProcessesForWorktree('w1', { localProvider: providerA })
    expect(providerA.shutdown).toHaveBeenCalledWith('w1@@aaaa', true)
    expect(providerB.shutdown).not.toHaveBeenCalled()
    expect(r1.providerStopped).toBe(1)

    const r2 = await killAllProcessesForWorktree('w1', { localProvider: providerB })
    expect(providerB.shutdown).toHaveBeenCalledWith('w1@@bbbb', true)
    expect(providerB.shutdown).toHaveBeenCalledTimes(1)
    expect(r2.providerStopped).toBe(1)
  })

  it('invokes runtime.stopTerminalsForWorktree when runtime is provided', async () => {
    const stopTerminalsForWorktree = vi.fn().mockResolvedValue({ stopped: 3 })
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']

    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    const result = await killAllProcessesForWorktree('w1', { runtime, localProvider })

    expect(stopTerminalsForWorktree).toHaveBeenCalledWith('w1')
    expect(result.runtimeStopped).toBe(3)
  })

  it('tolerates runtime.stopTerminalsForWorktree throwing (headless assertGraphReady reject)', async () => {
    const stopTerminalsForWorktree = vi.fn().mockRejectedValue(new Error('graph not ready'))
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']

    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    const result = await killAllProcessesForWorktree('w1', { runtime, localProvider })

    expect(result.runtimeStopped).toBe(0)
  })
})
