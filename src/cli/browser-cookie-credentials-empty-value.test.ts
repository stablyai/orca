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
import { okFixture, queueFixtures } from './test-fixtures'

// Why: CookieSet.value and SetCredentials.pass accept any string, empty included,
// while name and user require a non-empty one.
describe('orca cli cookie set and set credentials preserve an empty value', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes an empty --value through to browser.cookie.set', async () => {
    queueFixtures(callMock, okFixture('req_cookie_set', { success: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['cookie', 'set', '--name', 'sid', '--value', '', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.cookie.set', {
      name: 'sid',
      value: '',
      worktree: undefined
    })
  })

  it('passes an empty --pass through to browser.setCredentials', async () => {
    queueFixtures(callMock, okFixture('req_set_credentials', { success: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['set', 'credentials', '--user', 'token', '--pass', '', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.setCredentials', {
      user: 'token',
      pass: '',
      worktree: undefined
    })
  })

  it('still rejects an empty --name before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['cookie', 'set', '--name', '', '--value', 'x', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --name')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('still rejects a missing --pass before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['set', 'credentials', '--user', 'token', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --pass')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
