import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from './index'
import { RuntimeClientError } from './runtime-client'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'

describe('orca cli browser page targeting', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes explicit page ids to snapshot without resolving the current worktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_snapshot', {
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['snapshot', '--page', 'page-1', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.snapshot', { page: 'page-1' })
  })

  it('resolves current worktree only when --page is combined with --worktree current', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_snapshot', {
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['snapshot', '--page', 'page-1', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.snapshot', {
      page: 'page-1',
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })

  it('passes page-targeted tab switches through without auto-scoping to the current worktree', async () => {
    queueFixtures(callMock, okFixture('req_switch', { switched: 2, browserPageId: 'page-2' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'switch', '--page', 'page-2', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabSwitch', {
      index: undefined,
      page: 'page-2'
    })
  })

  it('still resolves the current worktree when tab switch --page is combined with --worktree current', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_switch', { switched: 2, browserPageId: 'page-2' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'switch', '--page', 'page-2', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.tabSwitch', {
      index: undefined,
      page: 'page-2',
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })
})

describe('orca cli browser waits and viewport flags', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives selector waits an explicit RPC timeout budget', async () => {
    queueFixtures(callMock, okFixture('req_wait', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: undefined,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 60_000 }
    )
  })

  it('extends selector wait RPC timeout when the user passes --timeout', async () => {
    queueFixtures(callMock, okFixture('req_wait', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--timeout', '12000', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: 12000,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 17000 }
    )
  })

  it('does not tell users Orca is down for a generic runtime timeout', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the Orca runtime to respond.'
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['wait', '--selector', '#ready', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(errorSpy).toHaveBeenCalledWith('Timed out waiting for the Orca runtime to respond.')
  })

  it('passes the mobile viewport flag through to browser.viewport', async () => {
    queueFixtures(
      callMock,
      okFixture('req_viewport', {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'viewport',
        '--width',
        '375',
        '--height',
        '812',
        '--scale',
        '2',
        '--mobile',
        '--worktree',
        'all',
        '--json'
      ],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith('browser.viewport', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
      worktree: undefined
    })
  })
})
