import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { proveClaudeChildExitWithReaper } from './claude-child-exit-proof-ladder'

function fakeTree(): ClaudeChildTreeReaper & { reap: ReturnType<typeof vi.fn> } {
  return {
    capture: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'exited'
  }
}

function rootStoppedBySigterm(stopMs: number, platform: NodeJS.Platform) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') {
        setTimeout(() => child.emit('exit', 0, 'SIGTERM'), stopMs)
      }
      return true
    })
  })
  const spawner = createClaudeCodeProcessSpawn(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every event, stream and process field used by the spawner and close.
    return child as unknown as ReturnType<typeof spawnProcess>
  }, platform)
  spawner.spawn({
    command: 'fixture-provider',
    args: [],
    env: {},
    signal: new AbortController().signal
  })
  const managed = spawner.managed
  if (!managed) {
    throw new Error('Fixture did not retain its managed child')
  }
  return { child, managed }
}

afterEach(() => vi.useRealTimers())

describe('Claude child exit proof ladder', () => {
  it('stops a supervised child with SIGTERM and waits out the supervisor stop before forcing', async () => {
    vi.useFakeTimers()
    const root = rootStoppedBySigterm(PROVIDER_SUPERVISOR_MAX_STOP_MS - 500, 'darwin')
    const tree = fakeTree()
    expect(root.managed.rootVerdict).toBe('live')
    const proof = proveClaudeChildExitWithReaper({ managed: root.managed, tree }, () => tree)
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS)
    await expect(proof).resolves.toBe(true)
    expect(root.child.stdin.writableEnded).toBe(true)
    expect(root.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(root.managed.lastCloseResult).toEqual({ root: 'exited', tree: 'exited' })
    expect(tree.reap).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never signals an unsupervised child for the graceful stop', async () => {
    vi.useFakeTimers()
    const root = rootStoppedBySigterm(0, 'win32')
    const tree = fakeTree()
    const proof = proveClaudeChildExitWithReaper({ managed: root.managed, tree }, () => tree)
    await vi.advanceTimersByTimeAsync(2_500)
    await expect(proof).resolves.toBe(false)
    expect(root.child.stdin.writableEnded).toBe(true)
    expect(root.child.kill).not.toHaveBeenCalledWith('SIGTERM')
    expect(tree.reap).toHaveBeenCalledOnce()
    expect(root.managed.lastCloseResult).toEqual({ root: 'live', tree: 'exited' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
