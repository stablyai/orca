import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
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
