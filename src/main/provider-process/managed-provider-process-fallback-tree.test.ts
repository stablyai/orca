import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderProcessSpawner } from './provider-process-spawn'
import type { DescendantSnapshot } from '../pty/process-retirement/pty-descendant-termination'
import { spawnManagedProviderProcess } from './managed-provider-process'

vi.mock('./provider-process-spawn', () => ({
  spawnProviderProcess: (
    spec: { program: string; args: string[]; env: NodeJS.ProcessEnv },
    spawn: ProviderProcessSpawner
  ) => spawn({ program: spec.program, args: spec.args, env: spec.env })
}))

// The real fallback teardown; only the primitives that touch the OS are faked.
const os = vi.hoisted(() => ({
  taskkill: vi.fn(async (): Promise<boolean> => true),
  capture: vi.fn(async (): Promise<DescendantSnapshot | null> => null),
  verifySnapshot: vi.fn(async () => 'exited' as const)
}))
vi.mock('../pty/process-retirement/windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: os.taskkill
}))
vi.mock('../pty/process-retirement/pty-descendant-termination', () => ({
  captureDescendantSnapshot: os.capture,
  hasUnambiguousStartTime: () => true
}))
vi.mock('../pty/process-retirement/pty-descendant-exit-verification', () => ({
  terminateDescendantSnapshotWithVerdict: os.verifySnapshot
}))
vi.mock('../crash-reporting/process-exits/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function rootOnly(platform: NodeJS.Platform) {
  const child = Object.assign(createFakePipedChild(), {
    pid: 4242,
    writerPid: 4242,
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
  const spawnImpl: ProviderProcessSpawner = () => child
  return spawnManagedProviderProcess(
    { command: 'fixture-provider', args: [] },
    { spawnImpl, platform, site: 'fixture-provider-teardown' }
  )
}

describe('fallback teardown never claims descendants it did not observe', () => {
  it('reports no observation when the POSIX process table cannot be read', async () => {
    vi.useFakeTimers()
    const closing = rootOnly('darwin').close()
    await vi.runAllTimersAsync()
    await expect(closing).resolves.toEqual({ root: 'exited', tree: null, killDelivered: true })
  })
})
