import { once } from 'node:events'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createVitest, type PoolOptions, type Vitest } from 'vitest/node'
import * as processes from '../../src/shared/child-process/run-process'
import { nodeRuntimePool } from './vitest-node-runtime-pool'

let context: Vitest
const children: processes.ChildProcessHandle[] = []
const spawn = processes.spawnProcess

beforeAll(async () => {
  context = await createVitest('test', { config: false, watch: false, include: [] })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
})

afterAll(async () => {
  await context.close()
})

function options(executable = process.execPath): PoolOptions {
  return {
    distPath: '',
    project: context.getRootProject(),
    method: 'run',
    environment: { name: 'node', options: null },
    execArgv: [],
    env: { ...process.env, ORCA_TEST_NODE_EXECUTABLE: executable }
  }
}

function captureChild(): void {
  vi.spyOn(processes, 'spawnProcess').mockImplementation((spec) => {
    const child = spawn(spec)
    children.push(child)
    return child
  })
}

it('rejects an unavailable Node executable without an uncaught error or leaked pipes', async () => {
  const output = context.logger.outputStream
  const before = output.getMaxListeners()
  const worker = nodeRuntimePool.createPoolWorker(options(resolve('missing-node-executable')))
  await expect(worker.start()).rejects.toMatchObject({ code: 'ENOENT' })
  await worker.stop()
  expect(output.getMaxListeners()).toBe(before)
})

it('clears shutdown timers and listeners when the kill syscall throws', async () => {
  captureChild()
  const worker = nodeRuntimePool.createPoolWorker(options())
  await worker.start()
  const child = children[0]
  vi.spyOn(child, 'kill').mockImplementation(() => {
    throw new Error('kill denied')
  })
  vi.useFakeTimers()
  await expect(worker.stop()).rejects.toThrow('kill denied')
  expect(vi.getTimerCount()).toBe(0)
  expect(child.listenerCount('exit')).toBe(0)
})

it('waits for a running Node worker to exit and restores its output listener budget', async () => {
  captureChild()
  const output = context.logger.outputStream
  const before = output.getMaxListeners()
  const worker = nodeRuntimePool.createPoolWorker(options())
  await worker.start()
  await worker.stop()
  expect(children[0].signalCode).toBe('SIGTERM')
  expect(output.getMaxListeners()).toBe(before)
})

it('reports a failed kill within its deadline rather than hanging teardown', async () => {
  captureChild()
  const worker = nodeRuntimePool.createPoolWorker(options())
  const output = context.logger.outputStream
  const before = output.getMaxListeners()
  await worker.start()
  const child = children[0]
  vi.spyOn(child, 'kill').mockReturnValue(false)
  vi.useFakeTimers()
  const stopped = expect(worker.stop()).rejects.toThrow('did not exit after SIGKILL')
  await vi.advanceTimersByTimeAsync(2_000)
  await stopped
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  expect(child.listenerCount('exit')).toBe(0)
  expect(output.getMaxListeners()).toBe(before)
})
