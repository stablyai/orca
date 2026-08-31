import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { terminateCodexAppServerProcessTree } from './codex-app-server-process-teardown'

function child() {
  return {
    pid: 1234,
    kill: vi.fn(() => true) as ChildProcess['kill']
  }
}

describe('terminateCodexAppServerProcessTree', () => {
  it('waits for the Windows tree kill before releasing the wrapper', async () => {
    const target = child()
    const release = Promise.withResolvers<void>()
    const terminateWindowsTree = vi.fn(() => release.promise)

    const teardown = terminateCodexAppServerProcessTree(target, undefined, {
      platform: 'win32',
      terminateWindowsTree
    })
    expect(target.kill).not.toHaveBeenCalled()
    release.resolve()
    await teardown

    expect(terminateWindowsTree).toHaveBeenCalledWith(1234)
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills exact Linux spawn-token PIDs before the recorded wrapper', async () => {
    const target = child()
    const findSpawnTokenProcesses = vi
      .fn<() => Promise<number[] | null>>()
      .mockResolvedValueOnce([1234, 2345, 3456])
      .mockResolvedValueOnce([1234])
      .mockResolvedValueOnce([1234])
    const signalPid = vi.fn()

    await expect(
      terminateCodexAppServerProcessTree(target, 'spawn-1', {
        platform: 'linux',
        findSpawnTokenProcesses,
        signalPid,
        isPidPresent: () => false,
        wait: async () => undefined
      })
    ).resolves.toBe(true)

    expect(signalPid.mock.calls).toEqual([
      [2345, 'SIGKILL'],
      [3456, 'SIGKILL']
    ])
    expect(target.kill).toHaveBeenCalledTimes(1)
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('keeps the wrapper reachable when Linux cannot prove descendant exit', async () => {
    const target = child()

    await expect(
      terminateCodexAppServerProcessTree(target, 'spawn-1', {
        platform: 'linux',
        findSpawnTokenProcesses: async () => null
      })
    ).resolves.toBe(false)

    expect(target.kill).not.toHaveBeenCalled()
  })

  it('waits for an owned POSIX snapshot before killing the wrapper', async () => {
    const target = child()
    const snapshot = { rootPgid: 1234, descendants: [], capturedAtMs: 1 }
    const release = Promise.withResolvers<boolean>()

    const teardown = terminateCodexAppServerProcessTree(target, undefined, {
      platform: 'darwin',
      captureDescendants: async () => snapshot,
      terminateDescendants: () => release.promise
    })
    await vi.waitFor(() => expect(target.kill).toHaveBeenCalledWith('SIGSTOP'))
    expect(target.kill).not.toHaveBeenCalledWith('SIGKILL')
    release.resolve(true)
    await teardown

    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
  })

  it('signals a proven dedicated POSIX process group without scanning descendants', async () => {
    const target = child()
    const captureDescendants = vi.fn()
    const signalProcessGroup = vi.fn()

    await expect(
      terminateCodexAppServerProcessTree(target, undefined, {
        platform: 'darwin',
        dedicatedProcessGroup: true,
        captureDescendants,
        signalProcessGroup
      })
    ).resolves.toBe(true)

    expect(signalProcessGroup).toHaveBeenCalledWith(1234, 'SIGKILL')
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(target.kill).not.toHaveBeenCalled()
  })

  it('keeps the dedicated-group wrapper reachable when signalling is unproven', async () => {
    const target = child()

    await expect(
      terminateCodexAppServerProcessTree(target, undefined, {
        platform: 'linux',
        dedicatedProcessGroup: true,
        signalProcessGroup: () => {
          throw Object.assign(new Error('denied'), { code: 'EPERM' })
        }
      })
    ).resolves.toBe(false)

    expect(target.kill).not.toHaveBeenCalled()
  })

  it('tears down 40 dedicated groups without process-table scans or cross-group fanout', async () => {
    const killMocks = Array.from({ length: 40 }, () => vi.fn(() => true))
    const targets = killMocks.map((kill, index) => ({
      pid: 10_000 + index,
      kill: kill as ChildProcess['kill']
    }))
    const captureDescendants = vi.fn()
    const signalProcessGroup = vi.fn()

    const results = await Promise.all(
      targets.map((target) =>
        terminateCodexAppServerProcessTree(target, undefined, {
          platform: 'linux',
          dedicatedProcessGroup: true,
          captureDescendants,
          signalProcessGroup
        })
      )
    )

    expect(results).toEqual(Array.from({ length: targets.length }, () => true))
    expect(signalProcessGroup.mock.calls).toEqual(targets.map((target) => [target.pid, 'SIGKILL']))
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(killMocks.every((kill) => kill.mock.calls.length === 0)).toBe(true)
  })
})
