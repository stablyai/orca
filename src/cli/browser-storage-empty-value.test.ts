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

// Why: the server's StorageKeyValue schema requires a non-empty key but accepts any
// string value, empty included. setItem(key, '') is a real operation distinct from an
// absent key, so `--value ""` must reach the RPC rather than being rejected as missing.
describe('orca cli storage set preserves an empty value', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes an empty --value through to browser.storage.local.set', async () => {
    queueFixtures(callMock, okFixture('req_storage_local_set', { success: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['storage', 'local', 'set', '--key', 'flag', '--value', '', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.storage.local.set', {
      key: 'flag',
      value: '',
      worktree: undefined
    })
  })

  it('passes an empty --value through to browser.storage.session.set', async () => {
    queueFixtures(callMock, okFixture('req_storage_session_set', { success: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['storage', 'session', 'set', '--key', 'flag', '--value', '', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.storage.session.set', {
      key: 'flag',
      value: '',
      worktree: undefined
    })
  })

  it('still rejects a missing --value before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['storage', 'local', 'set', '--key', 'flag', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --value')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
