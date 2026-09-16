import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../shared/child-process/process-spec'

const callMock = vi.fn()
const runProcessMock = vi.fn()

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

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'

const VAULT_REF = 'op://Private/Acme staging/password'

describe('orca fill --secret-ref', () => {
  beforeEach(() => {
    callMock.mockReset()
    runProcessMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fills from the vault without printing the secret or putting it in argv', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'hunter2\n',
      stderr: '',
      timedOut: false
    })
    queueFixtures(callMock, okFixture('req_fill', { filled: '@e2' }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['fill', '--element', '@e2', '--secret-ref', VAULT_REF, '--page', 'page-1'], '/tmp')

    expect(callMock).toHaveBeenCalledWith('browser.fill', {
      element: '@e2',
      value: 'hunter2',
      page: 'page-1'
    })
    const spec = runProcessMock.mock.calls[0]?.[0] as ProcessSpec
    expect(spec.args).toEqual(['read', '--no-newline', VAULT_REF])
    const printed = log.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(printed).not.toContain('hunter2')
    expect(printed).toContain(VAULT_REF)
  })

  it('keeps the secret out of --json output too', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'hunter2',
      stderr: '',
      timedOut: false
    })
    queueFixtures(callMock, okFixture('req_fill', { filled: '@e2' }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['fill', '--element', '@e2', '--secret-ref', VAULT_REF, '--page', 'page-1', '--json'],
      '/tmp'
    )

    expect(log.mock.calls.map((args) => args.join(' ')).join('\n')).not.toContain('hunter2')
  })

  it('rejects --value together with --secret-ref instead of silently preferring one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['fill', '--element', '@e2', '--value', 'typed', '--secret-ref', VAULT_REF, '--page', 'p'],
      '/tmp'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('does not reach the browser when the vault lookup fails', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'error: not signed in',
      timedOut: false
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['fill', '--element', '@e2', '--secret-ref', VAULT_REF, '--page', 'p'], '/tmp')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
