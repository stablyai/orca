import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type * as ManagedProviderProcessModule from '../provider-process/managed-provider-process'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import {
  CLAUDE_READER_DRAIN_AFTER_EXIT_MS,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'

const mocks = vi.hoisted(() => {
  const refresh = vi.fn()
  const closeWriter = vi.fn()
  const tree = {
    capture: vi.fn(async () => {}),
    refresh: (...args: unknown[]) => refresh(...args),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'unverifiable' as const,
    forcedReapAttempted: false
  }
  return { closeWriter, refresh, tree }
})

vi.mock('./claude-agent-sdk-exit-proof', () => ({
  createClaudeChildTreeReaper: vi.fn(() => mocks.tree)
}))

vi.mock('../provider-process/managed-provider-process', async (importOriginal) => {
  const original = await importOriginal<typeof ManagedProviderProcessModule>()
  return {
    ...original,
    spawnManagedProviderProcess: (
      ...args: Parameters<typeof original.spawnManagedProviderProcess>
    ) => {
      const managed = original.spawnManagedProviderProcess(...args)
      managed.closeWriter = async () =>
        (await mocks.closeWriter())
          ? { root: 'exited', tree: 'exited' }
          : { root: 'live', tree: 'unverifiable' }
      return managed
    }
  }
})

function fakeChild(
  streams: { stdout: PassThrough; stderr: PassThrough } = {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  }
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only pid, the three pipes and kill, which this fake carries.
  return Object.assign(child, {
    pid: 424242,
    stdin: new PassThrough(),
    stdout: streams.stdout,
    stderr: streams.stderr,
    kill: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
}

describe('Claude stream-json close ordering', () => {
  it('stops pulling SDK messages until reading resumes', async () => {
    mocks.refresh.mockReset()
    mocks.closeWriter.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.closeWriter.mockResolvedValue(true)
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
    mocks.closeWriter.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.closeWriter.mockResolvedValue(true)
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

  // Inherited pipes must not keep sends and Stops waiting after proven exit.
  it('resolves a proven close though the output never ends', async () => {
    mocks.refresh.mockReset()
    mocks.closeWriter.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.closeWriter.mockResolvedValue(true)
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      let closed: boolean | undefined
      void connection.close().then((value) => {
        closed = value
      })
      await vi.advanceTimersByTimeAsync(CLAUDE_READER_DRAIN_AFTER_EXIT_MS - 1)
      expect(closed).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(closed).toBe(true)
      expect(warn).toHaveBeenCalledWith(
        '[claude-stream-json] output still open after the proven exit:',
        expect.anything()
      )
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })
})
