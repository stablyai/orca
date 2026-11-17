import type { EventEmitter } from 'node:events'
import type * as NodeChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildModule from '../../../worker-thread-child-process/worker-thread-child-process'

const worker = vi.hoisted(() => ({
  available: true,
  spawn: vi.fn()
}))
const treeKills = vi.hoisted(() => {
  const state: { args: string[][]; killers: EventEmitter[]; via: ('main' | 'worker')[] } = {
    args: [],
    killers: [],
    via: []
  }
  return state
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    spawn: (command: string, args: string[], options: NodeChildProcess.SpawnOptions) => {
      if (command !== 'taskkill') {
        return actual.spawn(command, args, options)
      }
      const killer = Object.assign(new EventEmitter(), { unref: () => {}, kill: () => true })
      treeKills.args.push(args)
      treeKills.killers.push(killer)
      treeKills.via.push('main')
      return killer
    }
  }
})
vi.mock('../../../pty/process-retirement/own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: () => true
}))
vi.mock('../../../worker-thread-child-process/worker-thread-child-process', async (original) => {
  const actual = await original<typeof WorkerChildModule>()
  return {
    ...actual,
    canSpawnOnWorkerThread: () => worker.available,
    spawnProcessOnWorkerThread: (
      spec: Parameters<typeof WorkerChildModule.spawnProcessOnWorkerThread>[0]
    ) => {
      if (spec.program !== 'taskkill') {
        return worker.spawn(spec)
      }
      const killer = new actual.WorkerThreadChildProcess(99, () => true)
      treeKills.args.push([...(spec.args ?? [])])
      treeKills.killers.push(killer)
      treeKills.via.push('worker')
      return killer
    }
  }
})

import {
  WORKER_CHILD_ABANDONED_CODE,
  WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'
import { execFileCapture } from './exec-file-capture'

const originalPlatform = process.platform

function finishedWorkerChild(code: number, stdout: string, stderr: string) {
  const child = new WorkerThreadChildProcess(1, () => true)
  process.nextTick(() => {
    child.receive({ type: 'spawn', id: 1, pid: 4242 })
    child.receive({ type: 'stdout', id: 1, chunk: new TextEncoder().encode(stdout) })
    child.receive({ type: 'stderr', id: 1, chunk: new TextEncoder().encode(stderr) })
    child.receive({ type: 'exit', id: 1, code, signal: null })
    child.receive({ type: 'close', id: 1, code, signal: null })
  })
  return child
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  worker.available = true
  worker.spawn.mockReset()
  treeKills.args = []
  treeKills.killers = []
  treeKills.via = []
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('Windows process creation off the calling loop', () => {
  it('starts the command on the worker with the current environment', async () => {
    worker.spawn.mockReturnValue(finishedWorkerChild(0, 'origin\n', ''))
    const result = await execFileCapture('git', ['remote'], { encoding: 'utf8' })
    expect(result.stdout).toBe('origin\n')
    expect(worker.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'git', args: ['remote'], env: process.env })
    )
  })

  it('keeps the execFile failure text', async () => {
    worker.spawn.mockReturnValue(finishedWorkerChild(128, '', 'fatal: not a git repository'))
    await expect(
      execFileCapture('git', ['status', '--short'], { encoding: 'utf8' })
    ).rejects.toMatchObject({
      message: 'Command failed: git status --short\nfatal: not a git repository',
      code: 128
    })
  })

  it("reports Git's own failure when Git closed stdin before reading it", async () => {
    const child = new WorkerThreadChildProcess(1, () => true)
    worker.spawn.mockReturnValue(child)
    const pending = execFileCapture('git', ['add', '--pathspec-from-file=-'], {
      encoding: 'utf8',
      stdin: 'a.txt\n'.repeat(20_000)
    })
    await vi.waitFor(() => expect(worker.spawn).toHaveBeenCalled())
    child.receive({ type: 'spawn', id: 1, pid: 4242 })
    child.receive({
      type: 'error',
      id: 1,
      error: { message: 'write EPIPE', code: 'EPIPE', syscall: 'write' }
    })
    child.receive({
      type: 'stderr',
      id: 1,
      chunk: new TextEncoder().encode("fatal: Unable to create 'index.lock': File exists.")
    })
    child.receive({ type: 'exit', id: 1, code: 128, signal: null })
    child.receive({ type: 'close', id: 1, code: 128, signal: null })
    await expect(pending).rejects.toMatchObject({
      message:
        "Command failed: git add --pathspec-from-file=-\nfatal: Unable to create 'index.lock': File exists.",
      code: 128
    })
  })

  it('ends the running Git tree before releasing it when the worker dies under it', async () => {
    const child = new WorkerThreadChildProcess(1, () => true)
    worker.spawn.mockReturnValue(child)
    const terminated = vi.fn()
    const pending = execFileCapture('git', ['status'], { onChildTerminated: terminated })
    await vi.waitFor(() => expect(worker.spawn).toHaveBeenCalled())
    child.receive({ type: 'spawn', id: 1, pid: 4242 })
    child.receive({
      type: 'error',
      id: 1,
      error: {
        message: 'Child process worker exited with code 1',
        code: WORKER_CHILD_ABANDONED_CODE
      }
    })
    await expect(pending).rejects.toThrow('Child process worker exited with code 1')
    expect(treeKills.args).toEqual([['/pid', '4242', '/t', '/f']])
    expect(terminated).not.toHaveBeenCalled()
    treeKills.killers[0]!.emit('close', 0)
    await vi.waitFor(() => expect(terminated).toHaveBeenCalledOnce())
  })

  it('ends the whole Git tree when output passes maxBuffer', async () => {
    const child = new WorkerThreadChildProcess(1, () => true)
    worker.spawn.mockReturnValue(child)
    const terminated = vi.fn()
    const pending = execFileCapture('git', ['log'], { maxBuffer: 4, onChildTerminated: terminated })
    await vi.waitFor(() => expect(worker.spawn).toHaveBeenCalled())
    child.receive({ type: 'spawn', id: 1, pid: 4242 })
    child.receive({ type: 'stdout', id: 1, chunk: new TextEncoder().encode('more than four') })
    await vi.waitFor(() => expect(treeKills.args).toEqual([['/pid', '4242', '/t', '/f']]))
    expect(treeKills.via).toEqual(['worker'])
    treeKills.killers[0]!.emit('close', 0)
    await expect(pending).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    child.receive({ type: 'close', id: 1, code: 1, signal: null })
    expect(terminated).toHaveBeenCalledOnce()
  })

  it('retires the pipes of a Git root that exited before its output overflowed', async () => {
    const send = vi.fn(() => true)
    const child = new WorkerThreadChildProcess(1, send)
    worker.spawn.mockReturnValue(child)
    const pending = execFileCapture('git', ['log'], { maxBuffer: 4 })
    await vi.waitFor(() => expect(worker.spawn).toHaveBeenCalled())
    child.receive({ type: 'spawn', id: 1, pid: 4242 })
    child.receive({ type: 'exit', id: 1, code: 0, signal: null })
    child.receive({ type: 'stdout', id: 1, chunk: new TextEncoder().encode('more than four') })
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'kill' }))
    )
    expect(treeKills.args).toEqual([])
    expect(send).toHaveBeenCalledWith({ type: 'discard-output', id: 1 })
    child.receive({ type: 'close', id: 1, code: 0, signal: null })
    await expect(pending).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('starts the tree kill from main when the worker dies before running it', async () => {
    const child = new WorkerThreadChildProcess(1, () => true)
    worker.spawn.mockReturnValue(child)
    const pending = execFileCapture('git', ['log'], { maxBuffer: 4 })
    await vi.waitFor(() => expect(worker.spawn).toHaveBeenCalled())
    child.receive({ type: 'spawn', id: 1, pid: 4242 })
    child.receive({ type: 'stdout', id: 1, chunk: new TextEncoder().encode('more than four') })
    await vi.waitFor(() => expect(treeKills.via).toEqual(['worker']))
    const queued = treeKills.killers[0]
    if (!(queued instanceof WorkerThreadChildProcess)) {
      throw new Error('taskkill was not queued on the worker')
    }
    queued.receive({
      type: 'error',
      id: 99,
      error: {
        message: 'Child process worker exited with code 1',
        code: WORKER_CHILD_ABANDONED_CODE
      }
    })
    await vi.waitFor(() => expect(treeKills.via).toEqual(['worker', 'main']))
    expect(treeKills.args[1]).toEqual(['/pid', '4242', '/t', '/f'])
    treeKills.killers[1]!.emit('close', 0)
    await expect(pending).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('runs on the calling loop when the worker cannot start', async () => {
    worker.available = false
    const result = await execFileCapture(process.execPath, ['-e', 'process.stdout.write("ran")'], {
      encoding: 'utf8'
    })
    expect(result.stdout).toBe('ran')
    expect(worker.spawn).not.toHaveBeenCalled()
  })
})
