import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageCommandProtocolVersion: 1
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BrowserClientHostCommandDispatcher', () => {
  it('executes one FIFO command per page and replays duplicates exactly', async () => {
    const create = deferred<BrowserClientHostCommandResult>()
    const navigate = deferred<BrowserClientHostCommandResult>()
    const handler = vi
      .fn()
      .mockReturnValueOnce(create.promise)
      .mockReturnValueOnce(navigate.promise)
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    const createCommand = command(1, 'create-a')
    const navigateCommand = command(2, 'navigate-a', 'navigate')

    const creating = dispatcher.dispatch(createCommand)
    const duplicateCreating = dispatcher.dispatch(createCommand)
    const navigating = dispatcher.dispatch(navigateCommand)
    expect(handler).toHaveBeenCalledOnce()
    expect(Object.isFrozen(handler.mock.calls[0]?.[0])).toBe(true)
    expect(Object.isFrozen(handler.mock.calls[0]?.[0].command)).toBe(true)

    create.resolve({ status: 'completed' })
    await expect(creating).resolves.toEqual({ status: 'completed' })
    await expect(duplicateCreating).resolves.toEqual({ status: 'completed' })
    expect(Object.isFrozen(await creating)).toBe(true)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    navigate.resolve({ status: 'completed' })
    await expect(navigating).resolves.toEqual({ status: 'completed' })
    await expect(dispatcher.dispatch(navigateCommand)).resolves.toEqual({ status: 'completed' })
    expect(handler).toHaveBeenCalledTimes(2)
    expect(() =>
      dispatcher.dispatch({
        ...createCommand,
        command: {
          type: 'createPage',
          browserProfileId: 'default',
          executionHostKey: 'host-key-b'
        }
      })
    ).toThrow('browser_host_command_sequence_conflict')
    expect(() =>
      dispatcher.dispatch({
        ...navigateCommand,
        command: { type: 'navigate', url: 'https://different.internal' }
      })
    ).toThrow('browser_host_command_sequence_conflict')
  })

  it('rejects stale authority, sequence gaps, conflicts, and non-create first commands', () => {
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler: vi.fn().mockResolvedValue({ status: 'completed' })
    })
    expect(() =>
      dispatcher.dispatch({ ...command(1, 'create-a'), authorityEpoch: 'epoch-b' })
    ).toThrow('browser_host_command_authority_stale')
    expect(() => dispatcher.dispatch(command(1, 'navigate-a', 'navigate'))).toThrow(
      'browser_host_command_create_required'
    )
    dispatcher.dispatch(command(1, 'create-a'))
    expect(() => dispatcher.dispatch(command(3, 'navigate-b', 'navigate'))).toThrow(
      'browser_host_command_sequence_gap'
    )
    expect(() => dispatcher.dispatch(command(1, 'different-id'))).toThrow(
      'browser_host_command_sequence_conflict'
    )
    expect(() => dispatcher.dispatch(command(2, 'create-b'))).toThrow(
      'browser_host_command_create_repeated'
    )
  })

  it('snapshots lease authority instead of following caller mutation', async () => {
    const mutableAuthority = { ...authority }
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority: mutableAuthority,
      handler: vi.fn().mockResolvedValue({ status: 'completed' })
    })
    mutableAuthority.authorityEpoch = 'epoch-b'

    await expect(dispatcher.dispatch(command(1, 'create-a'))).resolves.toEqual({
      status: 'completed'
    })
    expect(() =>
      dispatcher.dispatch({ ...command(2, 'navigate-a', 'navigate'), authorityEpoch: 'epoch-b' })
    ).toThrow('browser_host_command_authority_stale')
  })

  it('bounds pages, active commands, and cross-page handler concurrency', async () => {
    const first = deferred<BrowserClientHostCommandResult>()
    const second = deferred<BrowserClientHostCommandResult>()
    const handler = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxPages: 2,
      maxActiveCommands: 2,
      maxConcurrentHandlers: 1
    })
    const pageA = dispatcher.dispatch(command(1, 'create-a'))
    const pageB = dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-b'))

    expect(handler).toHaveBeenCalledOnce()
    expect(() => dispatcher.dispatch(command(2, 'navigate-b', 'navigate', 'page-b'))).toThrow(
      'browser_host_command_capacity'
    )
    expect(() => dispatcher.dispatch(command(1, 'create-c', 'createPage', 'page-c'))).toThrow(
      'browser_host_page_capacity'
    )
    first.resolve({ status: 'completed' })
    await pageA
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    second.resolve({ status: 'completed' })
    await pageB
  })

  it('aborts and joins exact page retirement before admitting a new generation', async () => {
    const handler = vi
      .fn()
      .mockImplementationOnce((_event: BrowserClientHostCommandEvent, signal: AbortSignal) => {
        return new Promise<BrowserClientHostCommandResult>((resolve) => {
          signal.addEventListener('abort', () => resolve({ status: 'completed' }), { once: true })
        })
      })
      .mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    const running = dispatcher.dispatch(command(1, 'create-a'))
    const retirement = dispatcher.retirePage('page-a', 1)

    await expect(running).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_host_command_cancelled'
    })
    await expect(retirement).resolves.toBe(true)
    expect(() => dispatcher.dispatch(command(1, 'stale-a'))).toThrow(
      'browser_host_page_generation_stale'
    )
    await dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-a', 2))
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('does not consume page authority when admission fails', async () => {
    const first = deferred<BrowserClientHostCommandResult>()
    const handler = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({
      status: 'completed'
    })
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxPages: 2,
      maxActiveCommands: 1
    })

    expect(() => dispatcher.dispatch(command(1, 'invalid-a', 'navigate', 'page-a'))).toThrow(
      'browser_host_command_create_required'
    )
    const running = dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-b'))
    expect(() => dispatcher.dispatch(command(1, 'create-c', 'createPage', 'page-c'))).toThrow(
      'browser_host_command_capacity'
    )
    first.resolve({ status: 'completed' })
    await running
    await expect(
      dispatcher.dispatch(command(1, 'create-c', 'createPage', 'page-c'))
    ).resolves.toEqual({ status: 'completed' })
  })

  it('fails a create dependency once and never runs later page commands', async () => {
    const handler = vi.fn().mockImplementationOnce(() => {
      throw new Error('create failed')
    })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    const create = dispatcher.dispatch(command(1, 'create-a'))
    const navigate = dispatcher.dispatch(command(2, 'navigate-a', 'navigate'))

    await expect(create).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_host_command_failed'
    })
    await expect(navigate).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_host_command_dependency_failed'
    })
    expect(() => dispatcher.dispatch(command(3, 'navigate-b', 'navigate'))).toThrow(
      'browser_host_command_dependency_failed'
    )
    expect(handler).toHaveBeenCalledOnce()
  })

  it('keeps a timed-out retirement fenced until its handler actually settles', async () => {
    vi.useFakeTimers()
    const stuck = deferred<BrowserClientHostCommandResult>()
    const handler = vi.fn().mockReturnValue(stuck.promise)
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      joinTimeoutMs: 50
    })
    const running = dispatcher.dispatch(command(1, 'create-a'))
    const retirement = dispatcher.retirePage('page-a', 1)
    const duplicateRetirement = dispatcher.retirePage('page-a', 1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(50)

    await expect(retirement).resolves.toBe(false)
    await expect(duplicateRetirement).resolves.toBe(false)
    await expect(running).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    expect(() => dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-a', 2))).toThrow(
      'browser_host_page_retirement_pending'
    )
    stuck.resolve({ status: 'completed' })
    await vi.runAllTimersAsync()
    await dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-a', 2))
  })

  it('installs the retirement join before synchronously entering the handler', async () => {
    vi.useFakeTimers()
    const stuck = deferred<BrowserClientHostCommandResult>()
    let retirement: Promise<boolean> | undefined
    let dispatcher: BrowserClientHostCommandDispatcher
    const handler = vi.fn(() => {
      retirement = dispatcher.retirePage('page-a', 1)
      return stuck.promise
    })
    dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      joinTimeoutMs: 50
    })
    const running = dispatcher.dispatch(command(1, 'create-a'))
    await vi.advanceTimersByTimeAsync(50)

    await expect(retirement).resolves.toBe(false)
    await expect(running).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    expect(() => dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-a', 2))).toThrow(
      'browser_host_page_retirement_pending'
    )
    stuck.resolve({ status: 'completed' })
    await vi.runAllTimersAsync()
  })

  it('publishes one shared retirement before an abort listener can reenter', async () => {
    vi.useFakeTimers()
    const stuck = deferred<BrowserClientHostCommandResult>()
    let reentrantRetirement: Promise<boolean> | undefined
    let dispatcher: BrowserClientHostCommandDispatcher
    const handler = vi.fn((_event: BrowserClientHostCommandEvent, signal: AbortSignal) => {
      signal.addEventListener(
        'abort',
        () => {
          reentrantRetirement = dispatcher.retirePage('page-a', 1)
        },
        { once: true }
      )
      return stuck.promise
    })
    dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      joinTimeoutMs: 50
    })
    const running = dispatcher.dispatch(command(1, 'create-a'))
    const retirement = dispatcher.retirePage('page-a', 1)

    expect(reentrantRetirement).toBeDefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    await expect(retirement).resolves.toBe(false)
    await expect(reentrantRetirement).resolves.toBe(false)
    await expect(running).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    stuck.resolve({ status: 'completed' })
    await vi.runAllTimersAsync()
  })

  it('removes a retired queued generation before scheduling its replacement', async () => {
    const first = deferred<BrowserClientHostCommandResult>()
    const handler = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({
      status: 'completed'
    })
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxConcurrentHandlers: 1
    })
    const pageA = dispatcher.dispatch(command(1, 'create-a'))
    const oldPageB = dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-b'))

    await expect(dispatcher.retirePage('page-b', 1)).resolves.toBe(true)
    await expect(oldPageB).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    const newPageB = dispatcher.dispatch(command(1, 'create-c', 'createPage', 'page-b', 2))
    first.resolve({ status: 'completed' })

    await pageA
    await expect(newPageB).resolves.toEqual({ status: 'completed' })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('retains a global stale-generation floor after forgetting retired page state', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(command(1, 'create-a'))
    await dispatcher.retirePage('page-a', 1)
    expect(dispatcher.forgetPage('page-a', 1)).toBe(true)

    expect(() => dispatcher.dispatch(command(1, 'replayed-a'))).toThrow(
      'browser_host_page_generation_stale'
    )
    await expect(
      dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-b', 2))
    ).resolves.toEqual({ status: 'completed' })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('expires old cached results instead of replaying unknown side effects', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxCachedResultsPerPage: 1
    })
    const create = command(1, 'create-a')
    const firstNavigation = command(2, 'navigate-a', 'navigate')
    const secondNavigation = command(3, 'navigate-b', 'navigate')
    await dispatcher.dispatch(create)
    await dispatcher.dispatch(firstNavigation)
    await dispatcher.dispatch(secondNavigation)

    await expect(dispatcher.dispatch(secondNavigation)).resolves.toEqual({ status: 'completed' })
    expect(() => dispatcher.dispatch(firstNavigation)).toThrow(
      'browser_host_command_result_expired'
    )
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('bounds cached results across pages, not only within each page', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxCachedResultsPerPage: 2,
      maxCachedCommandResults: 2
    })
    const createA = command(1, 'create-a')
    const navigateA = command(2, 'navigate-a', 'navigate')
    await dispatcher.dispatch(createA)
    await dispatcher.dispatch(navigateA)
    await dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-b'))

    await expect(dispatcher.dispatch(navigateA)).resolves.toEqual({ status: 'completed' })
    expect(() => dispatcher.dispatch(createA)).toThrow('browser_host_command_result_expired')
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('releases a retired generation cache before charging its replacement', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxCachedCommandResults: 2
    })
    const pageB = command(1, 'create-b', 'createPage', 'page-b')
    await dispatcher.dispatch(pageB)
    await dispatcher.dispatch(command(1, 'create-a'))
    await dispatcher.retirePage('page-a', 1)
    await dispatcher.dispatch(command(1, 'create-c', 'createPage', 'page-a', 2))

    await expect(dispatcher.dispatch(pageB)).resolves.toEqual({ status: 'completed' })
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('bounds close while canceling queued and non-cooperative handlers', async () => {
    vi.useFakeTimers()
    const stuck = deferred<BrowserClientHostCommandResult>()
    const handler = vi.fn().mockReturnValue(stuck.promise)
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxConcurrentHandlers: 1,
      joinTimeoutMs: 50
    })
    const running = dispatcher.dispatch(command(1, 'create-a'))
    const queued = dispatcher.dispatch(command(1, 'create-b', 'createPage', 'page-b'))
    const closing = dispatcher.close()
    await vi.advanceTimersByTimeAsync(50)

    await expect(running).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    await expect(queued).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    await expect(closing).resolves.toBe(false)
    expect(() => dispatcher.dispatch(command(1, 'create-c', 'createPage', 'page-c'))).toThrow(
      'browser_host_command_dispatcher_closed'
    )
    let handlersSettled = false
    void dispatcher.whenClosed().then(() => {
      handlersSettled = true
    })
    await Promise.resolve()
    expect(handlersSettled).toBe(false)
    stuck.resolve({ status: 'completed' })
    await vi.runAllTimersAsync()
    await expect(dispatcher.whenClosed()).resolves.toBeUndefined()
  })
})

function command(
  commandSequence: number,
  commandId: string,
  type: 'createPage' | 'navigate' = 'createPage',
  browserPageId = 'page-a',
  pageHostGeneration = 1
): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    pageCommandProtocolVersion: 1,
    ...authority,
    browserPageId,
    pageHostGeneration,
    commandSequence,
    commandId,
    command:
      type === 'createPage'
        ? { type, browserProfileId: 'default', executionHostKey: 'host-key-a' }
        : { type, url: 'https://remote.internal' }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}
