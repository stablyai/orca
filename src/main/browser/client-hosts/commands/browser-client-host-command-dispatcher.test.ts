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
