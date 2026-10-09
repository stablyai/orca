import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import { spawnManagedProviderProcess } from './managed-provider-process'

// The real fallback teardown; only the primitives that touch the OS are faked.
const os = vi.hoisted(() => ({
  taskkill: vi.fn(async (): Promise<boolean> => true),
  capture: vi.fn(async (): Promise<DescendantSnapshot | null> => null),
  verifySnapshot: vi.fn(async () => 'exited' as const)
}))
vi.mock('../windows-process-tree-kill', () => ({ terminateWindowsProcessTree: os.taskkill }))
vi.mock('../pty-descendant-termination', () => ({ captureDescendantSnapshot: os.capture }))
vi.mock('../pty-descendant-exit-verification', () => ({
  terminateDescendantSnapshotWithVerdict: os.verifySnapshot
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function rootOnly(platform: NodeJS.Platform) {
  const child = Object.assign(createFakePipedChild(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // Only the root dies to SIGKILL; nothing in these paths examines a descendant.
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') {
        queueMicrotask(() => child.emit('exit', null, 'SIGKILL'))
      }
      return true
    })
  })
  const spawnImpl: PipedProcessSpawner = () => child
  return spawnManagedProviderProcess(
    { command: 'fixture-provider', args: [] },
    { spawnImpl, platform, site: 'fixture-provider-teardown' }
  )
}

describe('fallback teardown never claims descendants it did not observe', () => {
  it.each([
    { taskkill: true, tree: 'exited' },
    { taskkill: false, tree: 'unverifiable' }
  ] as const)(
    "reports taskkill's own verdict after a Windows tree kill: taskkill $taskkill",
    async ({ taskkill, tree }) => {
      vi.useFakeTimers()
      os.taskkill.mockResolvedValueOnce(taskkill)
      const closing = rootOnly('win32').close()
      await vi.advanceTimersByTimeAsync(1_500)
      await expect(closing).resolves.toEqual({ root: 'exited', tree })
      expect(os.taskkill).toHaveBeenCalledOnce()
    }
  )

  it('reports no observation when the POSIX process table cannot be read', async () => {
    vi.useFakeTimers()
    const closing = rootOnly('darwin').close()
    await vi.advanceTimersByTimeAsync(5_500)
    await expect(closing).resolves.toEqual({ root: 'exited', tree: null })
    expect(os.capture).toHaveBeenCalledOnce()
    expect(os.verifySnapshot).not.toHaveBeenCalled()
  })

  it('reports exited only when the captured descendants were verified gone', async () => {
    vi.useFakeTimers()
    os.capture.mockResolvedValueOnce({ rootPgid: 1, descendants: [], capturedAtMs: 1 })
    const closing = rootOnly('darwin').close()
    await vi.advanceTimersByTimeAsync(5_500)
    await expect(closing).resolves.toEqual({ root: 'exited', tree: 'exited' })
    expect(os.verifySnapshot).toHaveBeenCalledOnce()
  })
})
