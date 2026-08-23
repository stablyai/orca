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

// Why: the server's Fill schema uses requiredStringAllowingEmpty and Select accepts any
// string value, empty included. Filling a field with '' clears it and selecting an
// <option value=""> is a real operation, so `--value ""` must reach the RPC rather than
// being rejected as missing.
describe('orca cli browser fill/select preserve an empty value', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes an empty --value through to browser.fill', async () => {
    queueFixtures(callMock, okFixture('req_fill', { filled: 'ref_1' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['fill', '--element', 'ref_1', '--value', '', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.fill', {
      element: 'ref_1',
      value: '',
      worktree: undefined
    })
  })

  it('passes an empty --value through to browser.select', async () => {
    queueFixtures(callMock, okFixture('req_select', { selected: 'ref_1' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['select', '--element', 'ref_1', '--value', '', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.select', {
      element: 'ref_1',
      value: '',
      worktree: undefined
    })
  })

  it('still rejects a missing --value before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['fill', '--element', 'ref_1', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --value')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
