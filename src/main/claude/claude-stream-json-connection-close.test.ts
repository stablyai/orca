import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from './claude-stream-json-connection'

const mocks = vi.hoisted(() => {
  const refresh = vi.fn()
  const proveClaudeChildExit = vi.fn()
  const tree = {
    capture: vi.fn(async () => {}),
    refresh: (...args: unknown[]) => refresh(...args),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'unverifiable' as const
  }
  return { proveClaudeChildExit, refresh, tree }
})

vi.mock('./claude-agent-sdk-exit-proof', () => ({
  createClaudeChildTreeReaper: vi.fn(() => mocks.tree),
  proveClaudeChildExit: (...args: unknown[]) => mocks.proveClaudeChildExit(...args)
}))

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter()
  return Object.assign(child, {
    pid: 424242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
}

describe('Claude stream-json close ordering', () => {
  it('stops pulling SDK messages until reading resumes', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(true)
    const child = fakeChild()
    const first = Promise.withResolvers<Record<string, unknown>>()
    const next = vi
      .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
      .mockImplementationOnce(async () => ({ value: await first.promise, done: false }))
      .mockResolvedValueOnce({ value: { type: 'second' }, done: false })
      .mockResolvedValue({ value: undefined, done: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const seen: string[] = []
    let connection: Awaited<ReturnType<typeof openClaudeStreamJsonConnection>>
    connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {
        onMessage: (message) => {
          seen.push(String(message.type))
          if (message.type === 'first') {
            connection.pauseReading?.()
          }
        }
      },
      () => child,
      queryImpl
    )

    first.resolve({ type: 'first' })
    await vi.waitFor(() => expect(seen).toEqual(['first']))
    await new Promise((resolve) => setImmediate(resolve))
    expect(next).toHaveBeenCalledOnce()

    connection.resumeReading?.()
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second']))
    expect(next).toHaveBeenCalledTimes(3)
    await expect(connection.close()).resolves.toBe(true)
  })

  it('releases a pulled frame when provider exit is reported', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(true)
    const child = fakeChild()
    const first = Promise.withResolvers<Record<string, unknown>>()
    const next = vi
      .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
      .mockImplementationOnce(async () => ({ value: await first.promise, done: false }))
      .mockResolvedValue({ value: undefined, done: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const events: string[] = []
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {
        onMessage: (message) => events.push(`message:${String(message.type)}`),
        onExit: () => events.push('exit')
      },
      () => child,
      queryImpl
    )

    connection.pauseReading?.()
    first.resolve({ type: 'task_notification' })
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
    expect(events).toEqual([])

    child.emit('exit', 1, null)
    await vi.waitFor(() => expect(events).toEqual(['exit', 'message:task_notification']))
    await expect(connection.close()).resolves.toBe(true)
  })

  it('returns an unproven close without waiting on a live output reader', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(false)
    const child = fakeChild()
    const next = vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>(() => {}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {},
      () => child,
      queryImpl
    )

    await expect(connection.close()).resolves.toBe(false)
    expect(next).toHaveBeenCalledOnce()
  })

  it('waits for the live tree refresh before ending stdin', async () => {
    const refreshDone = Promise.withResolvers<void>()
    mocks.refresh.mockReturnValueOnce(refreshDone.promise)
    mocks.proveClaudeChildExit.mockResolvedValueOnce(true)
    const child = fakeChild()
    const launch: ClaudeStreamJsonLaunch = {
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo'
    }
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      if (!params.options) {
        throw new Error('missing SDK options')
      }
      params.options.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      void (async () => {
        for await (const _message of params.prompt) {
          // The SDK owns the transport write; the close test only needs its EOF boundary.
        }
        child.stdin.end()
      })()
      return (async function* () {})()
    }) as typeof query
    const connection = await openClaudeStreamJsonConnection(launch, {}, () => child, queryImpl)

    const closing = connection.close()
    await new Promise((resolve) => setImmediate(resolve))
    expect(child.stdin.writableEnded).toBe(false)

    refreshDone.resolve()
    await expect(closing).resolves.toBe(true)
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('requests a fresh close boundary after an output capture starts', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    const outputCapture = Promise.withResolvers<void>()
    const closeCapture = Promise.withResolvers<void>()
    mocks.refresh
      .mockReturnValueOnce(outputCapture.promise)
      .mockReturnValueOnce(closeCapture.promise)
    mocks.proveClaudeChildExit.mockResolvedValueOnce(true)
    const child = fakeChild()
    const launch: ClaudeStreamJsonLaunch = {
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo'
    }
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      void (async () => {
        for await (const _message of params.prompt) {
          // The SDK owns the transport write; the close test only needs its EOF boundary.
        }
        child.stdin.end()
      })()
      return (async function* () {})()
    }) as typeof query
    const connection = await openClaudeStreamJsonConnection(launch, {}, () => child, queryImpl)

    child.stderr.emit('data', 'output')
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
    const closing = connection.close()
    await Promise.resolve()

    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    expect(child.stdin.writableEnded).toBe(false)

    outputCapture.resolve()
    await Promise.resolve()
    expect(child.stdin.writableEnded).toBe(false)
    closeCapture.resolve()
    await expect(closing).resolves.toBe(true)
    expect(child.stdin.writableEnded).toBe(true)
  })
})
