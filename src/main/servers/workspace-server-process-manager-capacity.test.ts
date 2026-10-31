import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { WorkspaceServerProcessManager } from './workspace-server-process-manager'
import type { WorkspaceServerFrame } from '../../shared/workspace-server-process'

const { signal, terminate } = vi.hoisted(() => ({ signal: vi.fn(), terminate: vi.fn() }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signal,
  forceTerminateProcessTree: terminate
}))
const managers: WorkspaceServerProcessManager[] = []
afterEach(async () => {
  signal.mockImplementation(async (child: EventEmitter) => {
    child.emit('close', 0, null)
  })
  terminate.mockResolvedValue(true)
  await Promise.all(managers.splice(0).map((manager) => manager.close()))
})
function fixture(fail = false) {
  signal.mockReset()
  terminate.mockReset()
  signal.mockImplementation(async (child: EventEmitter) => {
    child.emit('close', 0, null)
  })
  terminate.mockResolvedValue(true)
  const manager = new WorkspaceServerProcessManager(() => {
    if (fail) {
      throw new Error('fixture start failure')
    }
    return Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough()
    }) as unknown as PipedChildProcess
  })
  managers.push(manager)
  const start = (port: number, worktreeId = 'a') =>
    manager.start({ worktreeId, port, name: 'test' }, { program: 'unused', cwd: '/tmp' })
  return { manager, start }
}
it('retires oldest inactive history at capacity and publishes its removal to existing subscribers', () => {
  const { manager, start } = fixture(true)
  const frames: WorkspaceServerFrame[] = []
  manager.subscribe('a', (frame) => frames.push(frame))
  for (let port = 4000; port < 4064; port++) {
    start(port)
  }
  start(4064, 'b')
  const snapshot = frames.findLast((frame) => frame.type === 'snapshot')
  expect(snapshot?.runs).toHaveLength(63)
  expect(snapshot?.runs.some((run) => run.port === 4000)).toBe(false)
  const all: number[] = []
  manager.subscribe('b', (frame) => {
    if (frame.type === 'snapshot') {
      all.push(...frame.runs.map((run) => run.port))
    }
  })
  expect(all).toEqual([4064])
})
it('refuses the 65th active server and stops only the requested workspace', async () => {
  const { manager, start } = fixture()
  for (let port = 4000; port < 4064; port++) {
    start(port, port === 4000 ? 'a' : 'b')
  }
  expect(() => start(4064)).toThrow('Too many')
  await manager.stopWorktree('a')
  expect(manager.hasActiveServers()).toBe(true)
  expect(signal).toHaveBeenCalledTimes(1)
  start(4064)
  await manager.stopWorktree('b')
  expect(manager.hasActiveServers()).toBe(true)
  await manager.stopWorktree('a')
  expect(manager.hasActiveServers()).toBe(false)
})
it('does not retire a run whose child exited while stop verification is pending', async () => {
  const { manager, start } = fixture()
  const first = start(4000)
  for (let port = 4001; port < 4064; port++) {
    start(port)
  }
  const verified = Promise.withResolvers<boolean>()
  terminate.mockReturnValueOnce(verified.promise)
  const stopping = manager.stop('a', 4000, first.id)
  await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1))
  expect(() => start(4064)).toThrow('Too many')
  expect(manager.hasActiveServers()).toBe(true)
  verified.resolve(true)
  await stopping
  expect(() => start(4064)).not.toThrow()
})

it('stops project-owned runs without stopping another project', async () => {
  const { manager, start } = fixture()
  start(4000, 'project-a::/tmp/a')
  start(4001, 'project-b::/tmp/b')
  await manager.stopProject('project-a')
  expect(signal).toHaveBeenCalledTimes(1)
  expect(manager.hasActiveServers()).toBe(true)
  await manager.stopProject('project-b')
  expect(manager.hasActiveServers()).toBe(false)
})
