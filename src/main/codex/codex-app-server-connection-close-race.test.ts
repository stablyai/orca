// An app-server exit that races a close: reported exactly once, by whichever side last watched it.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from './codex-app-server-posix-supervisor'

// The forced tree kill, controlled per test: it decides whether a close can prove the exit.
const teardown = vi.hoisted(() => ({ impl: async (): Promise<boolean> => true }))
vi.mock('./codex-app-server-process-teardown', () => ({
  terminateCodexAppServerProcessTree: () => teardown.impl()
}))

// close() waits out the supervisor's own stop before forcing the tree.
const GRACEFUL_EXIT_MS = process.platform === 'win32' ? 1_500 : PROVIDER_SUPERVISOR_MAX_STOP_MS

afterEach(() => {
  vi.useRealTimers()
  teardown.impl = async () => true
})

type StubChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  pid: number
  kill: ReturnType<typeof vi.fn>
}

async function openStub(reports: string[]) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries every child member the connection reads.
  const child = new EventEmitter() as StubChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  // Outside any real process table, so nothing here can signal a real process.
  child.pid = 9_999_999
  child.kill = vi.fn()
  child.stdin.once('data', () => child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`))
  const connection = await openCodexAppServerConnection(
    { command: 'codex', args: ['app-server'] },
    { onExit: () => reports.push('exit') },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub stands in for the spawned child.
    (() => child) as unknown as typeof spawnProcess
  )
  const exit = (): void => {
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  return { connection, exit }
}

it('reports an exit that lands while a close is giving up once, after it gave up', async () => {
  vi.useFakeTimers()
  const reports: string[] = []
  const { connection, exit } = await openStub(reports)
  const kill = Promise.withResolvers<boolean>()
  teardown.impl = () => kill.promise

  const first = connection.close()
  await vi.advanceTimersByTimeAsync(GRACEFUL_EXIT_MS + 10)
  exit()
  expect(reports).toEqual([])
  kill.resolve(false)
  await expect(first).resolves.toBe(false)

  expect(reports).toEqual(['exit'])
  await expect(connection.close()).resolves.toBe(true)
  exit()
  expect(reports).toEqual(['exit'])
})

it('reports once when two closes both give up and the exit comes after', async () => {
  vi.useFakeTimers()
  const reports: string[] = []
  const { connection, exit } = await openStub(reports)
  teardown.impl = async () => false

  const first = connection.close()
  const second = connection.close()
  await vi.advanceTimersByTimeAsync(GRACEFUL_EXIT_MS + 10)
  await expect(first).resolves.toBe(false)
  await expect(second).resolves.toBe(false)
  expect(reports).toEqual([])
  exit()

  expect(reports).toEqual(['exit'])
})
