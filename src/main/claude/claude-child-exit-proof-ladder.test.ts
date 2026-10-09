import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import {
  createClaudeChildTreeReaper,
  type ClaudeChildTreeReaper
} from './claude-agent-sdk-exit-proof'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { managedChild } from './claude-child-exit-proof-fixture'
import { proveClaudeChildExitWithReaper } from './claude-child-exit-proof-ladder'

function fakeTree(): ClaudeChildTreeReaper & { reap: ReturnType<typeof vi.fn> } {
  return {
    capture: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'exited',
    forcedReapAttempted: false
  }
}

function rootStoppedBySigterm(stopMs: number, platform: NodeJS.Platform) {
  const child = Object.assign(createFakePipedChild(), {
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
    return child
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

/** A root that leaves on stdin end when `leavesOnStdinEnd`, otherwise once killed (or, with
 *  `leavesOnKill` false, only when the test emits its exit). Closed under `closePlatform`'s rules. */
function fixtureRoot(
  closePlatform: NodeJS.Platform,
  leavesOnStdinEnd: boolean,
  leavesOnKill = true
) {
  const child = Object.assign(createFakePipedChild(), {
    pid: 4321,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      if (leavesOnKill) {
        child.emit('exit', null, 'SIGKILL')
      }
      return true
    })
  })
  if (leavesOnStdinEnd) {
    child.stdin.on('finish', () => child.emit('exit', 0, null))
  }
  return { child, managed: managedChild(child, closePlatform) }
}

function windowsTree(
  root: ReturnType<typeof fixtureRoot>,
  terminateWindowsTree: (rootPid: number) => Promise<boolean>
) {
  const captureDescendants = vi.fn(async () => null)
  const tree = createClaudeChildTreeReaper(root.child, {
    platform: 'win32',
    exited: () => root.managed.rootVerdict === 'exited',
    captureDescendants,
    terminateWindowsTree
  })
  return { tree, reap: vi.spyOn(tree, 'reap'), captureDescendants }
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

  it('on Windows proves a close when Claude leaves on its own after its stdin ends', async () => {
    const root = fixtureRoot('win32', true)
    const terminateWindowsTree = vi.fn(async () => true)
    const { tree, reap, captureDescendants } = windowsTree(root, terminateWindowsTree)

    await expect(
      proveClaudeChildExitWithReaper({ managed: root.managed, tree }, () => tree)
    ).resolves.toBe(true)

    // No claim about what Claude started: nothing is read, reaped or taskkilled after it left.
    expect(reap).not.toHaveBeenCalled()
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(root.child.kill).not.toHaveBeenCalled()
    expect(root.managed.lastCloseResult).toEqual({
      root: 'exited',
      tree: 'unverifiable',
      selfExit: true
    })
  })

  it.each([
    { taskkill: true, proven: true },
    { taskkill: false, proven: false }
  ])(
    'on Windows a forced close is proven only by taskkill: taskkill $taskkill',
    async ({ taskkill, proven }) => {
      const root = fixtureRoot('win32', false)
      const terminateWindowsTree = vi.fn(async () => taskkill)
      const { tree } = windowsTree(root, terminateWindowsTree)

      await expect(
        proveClaudeChildExitWithReaper({ managed: root.managed, tree }, () => tree)
      ).resolves.toBe(proven)

      expect(terminateWindowsTree).toHaveBeenCalledWith(4321)
      // The root still leaves through its held handle whatever taskkill reported.
      expect(root.managed.rootVerdict).toBe('exited')
    },
    10_000
  )

  it('on POSIX still reaps a root that left on its own and keeps the tree verdict', async () => {
    const root = fixtureRoot('linux', true)
    const tree = { ...fakeTree(), treeVerdict: 'unverifiable' as const }

    await expect(
      proveClaudeChildExitWithReaper({ managed: root.managed, tree }, () => tree)
    ).resolves.toBe(false)
    expect(tree.reap).toHaveBeenCalledOnce()
  })

  it('on Windows a retried close after a failed taskkill stays unproven once the root exits', async () => {
    const root = fixtureRoot('win32', false, false)
    const terminateWindowsTree = vi.fn(async () => false)
    const { tree } = windowsTree(root, terminateWindowsTree)
    const close = () => proveClaudeChildExitWithReaper({ managed: root.managed, tree }, () => tree)

    await expect(close()).resolves.toBe(false)
    // The exit lands only after the forced wait: it is not Claude leaving on its own.
    root.child.emit('exit', null, 'SIGKILL')
    await expect(close()).resolves.toBe(false)

    expect(terminateWindowsTree).toHaveBeenCalledOnce()
    expect(tree.forcedReapAttempted).toBe(true)
    expect(tree.treeVerdict).toBe('unverifiable')
  }, 10_000)

  it.each([
    { taskkill: true, proven: true },
    { taskkill: false, proven: false }
  ])(
    'on Windows a reap outside a close keeps taskkill as the verdict: taskkill $taskkill',
    async ({ taskkill, proven }) => {
      // The transport-failure reap (stdin error, reader failure) kills the live tree itself.
      const root = fixtureRoot('win32', false)
      const terminateWindowsTree = vi.fn(async () => taskkill)
      const { tree } = windowsTree(root, terminateWindowsTree)
      await tree.reap()
      expect(root.managed.rootVerdict).toBe('exited')

      await expect(
        proveClaudeChildExitWithReaper({ managed: root.managed, tree }, () => tree)
      ).resolves.toBe(proven)
      expect(terminateWindowsTree).toHaveBeenCalledOnce()
    }
  )
})
