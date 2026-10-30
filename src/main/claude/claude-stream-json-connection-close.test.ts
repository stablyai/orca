import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type * as ManagedProviderProcessModule from '../provider-process/managed-provider-process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  openProviderTimelineRig,
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CLAUDE_READER_DRAIN_AFTER_EXIT_MS,
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from './claude-stream-json-connection'

const mocks = vi.hoisted(() => {
  const refresh = vi.fn()
  const closeWriter = vi.fn()
  const tree = {
    capture: vi.fn(async () => {}),
    refresh: (...args: unknown[]) => refresh(...args),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'unverifiable' as const,
    forcedReapAttempted: false,
    killDelivered: false
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
      managed.closeWriter = async () => {
        const result = await mocks.closeWriter()
        return typeof result === 'object'
          ? result
          : result
            ? { root: 'exited', tree: 'exited' }
            : { root: 'live', tree: 'unverifiable' }
      }
      return managed
    }
  }
})

function fakeChild(
  streams: { stdout: PassThrough; stderr: PassThrough } = {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  }
) {
  return Object.assign(createFakePipedChild(424242), {
    stdout: streams.stdout,
    stderr: streams.stderr
  })
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
        next,
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
        next,
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
    await vi.waitFor(() => expect(events).toEqual(['message:task_notification']))

    child.emit('exit', 1, null)
    await vi.waitFor(() => expect(events).toEqual(['message:task_notification', 'exit']))
    await expect(connection.close()).resolves.toBe(true)
  })

  it('reports an exit whose stdout ended first once the exit is seen, with its usual reason', async () => {
    mocks.refresh.mockReset()
    mocks.closeWriter.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.closeWriter.mockResolvedValue(true)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = fakeChild({ stdout, stderr })
    const next = vi
      .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
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
        next,
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const exits: string[] = []
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      { onExit: (error, exit) => exits.push(`${exit?.expected}: ${error.message}`) },
      () => child,
      queryImpl
    )

    stderr.write('session limit reached\n')
    stdout.end()
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
    await new Promise((resolve) => setImmediate(resolve))
    expect(exits).toEqual([])

    child.emit('exit', 1, null)
    await vi.waitFor(() =>
      expect(exits).toEqual(['false: claude stream-json exited (code 1): session limit reached'])
    )
    await connection.close()
  })

  it('returns an unproven close without waiting on a live output reader', async () => {
    mocks.refresh.mockReset()
    mocks.closeWriter.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.closeWriter.mockResolvedValue(false)
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
        next,
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

  it('runs the stop ladder again on a close after an unproven attempt, refusing input meanwhile', async () => {
    mocks.refresh.mockReset()
    mocks.closeWriter.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.closeWriter.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const child = fakeChild()
    const next = vi.fn(async (): Promise<IteratorResult<Record<string, unknown>>> => ({
      value: undefined,
      done: true
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        next,
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
    await expect(connection.send({ type: 'user' })).rejects.toThrow()
    await expect(connection.close()).resolves.toBe(true)
    expect(mocks.closeWriter).toHaveBeenCalledTimes(2)
  })

  // Inherited pipes must not keep sends and Stops waiting after proven exit.
  it('rejects an empty noncooperative reader after bounded proven-process cleanup', async () => {
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
        next,
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
      let closed: unknown
      void connection.close().then(
        (value) => {
          closed = value
        },
        (error: unknown) => {
          closed = error
        }
      )
      await vi.advanceTimersByTimeAsync(CLAUDE_READER_DRAIN_AFTER_EXIT_MS + 1_000 - 1)
      expect(closed).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(closed).toEqual(new Error('Claude output reader did not complete after input EOF'))
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('reports a root that exits after its close came back unproven as that close ending', async () => {
    mocks.refresh.mockReset()
    mocks.closeWriter.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.closeWriter.mockResolvedValue(false)
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
        next,
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const exits: (boolean | undefined)[] = []
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      { onExit: (_error, exit) => exits.push(exit?.expected) },
      () => child,
      queryImpl
    )
    await expect(connection.close()).resolves.toBe(false)

    child.emit('exit', 0, 'SIGTERM')

    await vi.waitFor(() => expect(exits).toEqual([true]))
  })

  it('waits for the live tree refresh before ending stdin', async () => {
    const refreshDone = Promise.withResolvers<void>()
    mocks.refresh.mockReturnValueOnce(refreshDone.promise)
    mocks.closeWriter.mockResolvedValueOnce(true)
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
    mocks.closeWriter.mockReset()
    const outputCapture = Promise.withResolvers<void>()
    const closeCapture = Promise.withResolvers<void>()
    mocks.refresh
      .mockReturnValueOnce(outputCapture.promise)
      .mockReturnValueOnce(closeCapture.promise)
    mocks.closeWriter.mockResolvedValueOnce(true)
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

it.each(['root-exit', 'requested-close', 'source-error'] as const)(
  'drains the installed SDK decoded queue and EOF before %s retires its original journal owner',
  async (ending) => {
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.closeWriter.mockReset().mockResolvedValue(true)
    const child = fakeChild()
    const rig = await openProviderTimelineRig()
    const translator = createClaudeJournalTranslator({ sink: rig.eventSink })
    const first = Promise.withResolvers<void>()
    const writer = Promise.withResolvers<void>()
    const transferred: string[] = []
    let completion: Promise<boolean> | undefined
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {
        onMessage: (message) => {
          transferred.push(String(message.uuid))
          translator.handle({ type: 'message', sessionId: SESSION, message })
          if (message.uuid === 'result-1') {
            void rig.journal.readInOrder(() => writer.promise)
            for (let index = 0; index < 512; index++) {
              rig.eventSink.appendItem(
                { provider: 'orca', clientMessageId: `pressure-${index}` },
                { kind: 'status', tone: 'info', text: 'queued' },
                { turnScope: { kind: 'thread' } }
              )
            }
            first.resolve()
          }
        },
        onExit: () => {
          transferred.push('exit')
          const retire = (): void => {
            translator.handle({ type: 'ended', sessionId: SESSION, reason: 'exit', observedAt: 2 })
            translator.dispose()
            transferred.push('complete')
          }
          completion = connection.close().then(
            (proven) => {
              retire()
              return proven
            },
            (error: unknown) => {
              retire()
              throw error
            }
          )
          void completion.catch(() => {})
        }
      },
      () => child,
      query
    )
    const unbind = rig.eventSink.bindReadingControl?.({
      pauseReading: () => connection.pauseReading?.(),
      resumeReading: () => connection.resumeReading?.()
    })
    try {
      for (const index of [1, 2, 3]) {
        child.stdout.write(
          `${JSON.stringify({
            type: 'user',
            session_id: 'provider-session',
            uuid: `result-${index}`,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: `tool-${index}`,
                  content: `complete received body ${index}`
                }
              ]
            }
          })}\n`
        )
      }
      await first.promise
      expect(transferred).toEqual(['result-1'])
      vi.useFakeTimers()
      const closing = ending === 'requested-close' ? connection.close() : undefined
      Object.assign(child, { exitCode: 0 })
      child.emit('exit', 0, null)
      expect(connection.closed).toBe(true)
      await expect(connection.send({ type: 'user' })).rejects.toThrow()
      await expect(connection.setModel('model-after-exit')).rejects.toThrow()
      if (ending === 'source-error') {
        child.stdout.emit('error', new Error('received source failed'))
      }
      // The inherited raw pipe stays open; EOF must come from the owned facade.
      await vi.advanceTimersByTimeAsync(1_000)
      void (ending === 'source-error'
        ? await expect(completion).rejects.toThrow('received source failed')
        : await expect(completion ?? closing).resolves.toBe(true))
      vi.useRealTimers()
      expect(transferred).toEqual(['result-1', 'exit', 'result-2', 'result-3', 'complete'])
      expect(child.stdout.destroyed).toBe(false)
      writer.resolve()
      await expect(rig.eventSink.written?.()).resolves.toEqual({ ok: true })
      const reopened = await rig.reopenJournal()
      const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
      expect(tools.map((row) => row.itemId)).toEqual(
        [1, 2, 3].map((index) => `orca:claude-tool%3Aprovider-session%3Atool-${index}`)
      )
      expect(tools.map((row) => row.body)).toEqual(
        [1, 2, 3].map((index) =>
          expect.objectContaining({
            output: expect.objectContaining({
              head: `complete received body ${index}`,
              truncated: false,
              byteLength: Buffer.byteLength(`complete received body ${index}`)
            })
          })
        )
      )
    } finally {
      vi.useRealTimers()
      writer.resolve()
      child.stdout.end()
      child.stderr.end()
      void (ending === 'source-error'
        ? await expect(connection.close()).rejects.toThrow('received source failed')
        : await connection.close())
      unbind?.()
      translator.dispose()
      await closeProviderTimelineRigs()
    }
  }
)

it('joins a real SDK decoded envelope held at public next beyond the former reader deadline', async () => {
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  mocks.closeWriter
    .mockReset()
    .mockResolvedValue({ root: 'live', tree: 'unverifiable', killDelivered: true })
  const child = fakeChild()
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const rig = await openProviderTimelineRig()
  const translator = createClaudeJournalTranslator({ sink: rig.eventSink })
  const transferred: string[] = []
  const exited = vi.fn()
  let nextSpy: { mockRestore(): void } | undefined
  const connection = await openClaudeStreamJsonConnection(
    { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
    {
      onMessage: (message) => {
        transferred.push(String(message.uuid))
        translator.handle({ type: 'message', sessionId: SESSION, message })
      },
      onExit: exited
    },
    () => child,
    (params) => {
      const actual = query(params)
      const next = actual.next.bind(actual)
      // Keep the installed parser, queue, generator and cleanup; control its public receipt seam.
      nextSpy = vi.spyOn(actual, 'next').mockImplementation(async (...args) => {
        const result = await next(...args)
        if (
          !result.done &&
          'uuid' in result.value &&
          result.value.uuid === '00000000-0000-4000-8000-000000000002'
        ) {
          held.resolve()
          await release.promise
        }
        return result
      })
      return actual
    }
  )
  try {
    for (const index of [1, 2, 3]) {
      child.stdout.write(
        `${JSON.stringify({
          type: 'user',
          session_id: 'slow-provider',
          uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: `slow-tool-${index}`,
                content: `full delayed body ${index}`
              }
            ]
          }
        })}\n`
      )
    }
    await held.promise
    vi.useFakeTimers()
    let retired = false
    const closing = connection.close().then((proven) => {
      translator.handle({ type: 'ended', sessionId: SESSION, reason: 'exit', observedAt: 2 })
      translator.dispose()
      retired = true
      return proven
    })
    // Acquisition grace ends, then the former processing deadline passes with real work owned.
    await vi.advanceTimersByTimeAsync(1_000 + CLAUDE_READER_DRAIN_AFTER_EXIT_MS + 1)
    expect(retired).toBe(false)
    expect(transferred).toEqual(['00000000-0000-4000-8000-000000000001'])
    await expect(connection.send({ type: 'user' })).rejects.toThrow()
    release.resolve()
    await expect(closing).resolves.toBe(true)
    vi.useRealTimers()
    expect(transferred).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003'
    ])
    expect(child.exitCode).toBeNull()
    expect(exited).not.toHaveBeenCalled()
    const reopened = await rig.reopenJournal()
    const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
    expect(tools.map((row) => row.itemId)).toEqual(
      [1, 2, 3].map((index) => `orca:claude-tool%3Aslow-provider%3Aslow-tool-${index}`)
    )
    expect(tools.map((row) => row.body)).toEqual(
      [1, 2, 3].map((index) =>
        expect.objectContaining({
          callId: `slow-tool-${index}`,
          output: expect.objectContaining({
            head: `full delayed body ${index}`,
            byteLength: 19,
            truncated: false
          })
        })
      )
    )
  } finally {
    vi.useRealTimers()
    release.resolve()
    child.stdout.end()
    child.stderr.end()
    await connection.close()
    nextSpy?.mockRestore()
    translator.dispose()
    await closeProviderTimelineRigs()
  }
})

it.each(['natural-valid', 'forced-valid', 'natural-invalid'] as const)(
  'uses the SDK stdout facade final-envelope disposition for %s',
  async (ending) => {
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.closeWriter.mockReset().mockResolvedValue(true)
    const child = fakeChild()
    const rig = await openProviderTimelineRig()
    const translator = createClaudeJournalTranslator({ sink: rig.eventSink })
    const transferred: string[] = []
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {
        onMessage: (message) => {
          transferred.push(String(message.uuid))
          translator.handle({ type: 'message', sessionId: SESSION, message })
        }
      },
      () => child,
      query
    )
    try {
      const finalEnvelope = JSON.stringify({
        type: 'user',
        session_id: 'eof-provider',
        uuid: 'final-envelope',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'eof-tool', content: 'complete final body' }
          ]
        }
      })
      child.stdout.write(ending === 'natural-invalid' ? finalEnvelope.slice(0, -1) : finalEnvelope)
      if (ending !== 'forced-valid') {
        child.stdout.end()
      }
      vi.useFakeTimers()
      Object.assign(child, { exitCode: 0 })
      child.emit('exit', 0, null)
      const closing = connection.close()
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(closing).resolves.toBe(true)
      vi.useRealTimers()
      translator.handle({ type: 'ended', sessionId: SESSION, reason: 'exit', observedAt: 2 })
      translator.dispose()
      expect(transferred).toEqual(ending === 'natural-valid' ? ['final-envelope'] : [])
      const reopened = await rig.reopenJournal()
      const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
      if (ending === 'natural-valid') {
        expect(tools.map((row) => row.itemId)).toEqual([
          'orca:claude-tool%3Aeof-provider%3Aeof-tool'
        ])
        expect(tools[0].body).toMatchObject({
          callId: 'eof-tool',
          output: { head: 'complete final body', byteLength: 19, truncated: false }
        })
      } else {
        expect(tools).toEqual([])
      }
      if (ending === 'forced-valid') {
        expect(child.stdout.destroyed).toBe(false)
      }
    } finally {
      vi.useRealTimers()
      child.stdout.end()
      child.stderr.end()
      await connection.close()
      translator.dispose()
      await closeProviderTimelineRigs()
    }
  }
)
