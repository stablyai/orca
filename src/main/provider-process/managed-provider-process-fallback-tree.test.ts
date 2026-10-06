import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { SUPERVISED_PROVIDER_GRACEFUL_EXIT_MS } from './provider-process-supervisor'

/** Above pid_max on every supported POSIX host, so the real group signal is ESRCH. */
const UNREACHABLE_PGID = 2_147_483_647
const SUPERVISED_LADDER_MS = SUPERVISED_PROVIDER_GRACEFUL_EXIT_MS + 1_000

// The real fallback teardown; only the primitives that touch the OS are faked.
const os = vi.hoisted(() => ({
  taskkill: vi.fn(async () => {}),
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
  const child = Object.assign(new EventEmitter(), {
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The managed lifecycle reads only events, pid, streams and kill from this fixture.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  return spawnManagedProviderProcess(
    { command: 'fixture-provider', args: [] },
    { spawnImpl, platform, site: 'fixture-provider-teardown' }
  )
}

describe('fallback teardown never claims descendants it did not observe', () => {
  it('reports no observation after a Windows tree kill, whose outcome is unreadable', async () => {
    vi.useFakeTimers()
    const closing = rootOnly('win32').close()
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(closing).resolves.toEqual({ root: 'exited', tree: null, providerKilled: true })
    expect(os.taskkill).toHaveBeenCalledOnce()
  })

  it('reports no observation, and kills nothing, when the POSIX process table cannot be read', async () => {
    vi.useFakeTimers()
    const closing = rootOnly('darwin').close()
    await vi.advanceTimersByTimeAsync(SUPERVISED_LADDER_MS)
    // The supervisor is resumed to finish its own stop; killing it alone would orphan the provider.
    await expect(closing).resolves.toEqual({ root: 'live', tree: null, providerKilled: false })
    expect(os.capture).toHaveBeenCalledOnce()
    expect(os.verifySnapshot).not.toHaveBeenCalled()
  })

  it('reports exited only when the captured descendants were verified gone', async () => {
    vi.useFakeTimers()
    os.capture.mockResolvedValueOnce({
      rootPgid: 4242,
      descendants: [
        { pid: UNREACHABLE_PGID, ppid: 4242, pgid: UNREACHABLE_PGID, startedAt: 'Mon Oct  5' }
      ],
      capturedAtMs: 1
    })
    const closing = rootOnly('darwin').close()
    await vi.advanceTimersByTimeAsync(SUPERVISED_LADDER_MS)
    await expect(closing).resolves.toEqual({ root: 'exited', tree: 'exited', providerKilled: true })
    expect(os.verifySnapshot).toHaveBeenCalledOnce()
  })
})
