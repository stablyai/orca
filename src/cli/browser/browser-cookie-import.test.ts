import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeTypes from '../runtime/types'

const callMock = vi.fn()

vi.mock('../runtime/types', () => {
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

  return { RuntimeClientError, RuntimeRpcFailureError }
})

vi.mock('../runtime-client', async () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  const { RuntimeClientError, RuntimeRpcFailureError } =
    await vi.importMock<typeof RuntimeTypes>('../runtime/types')

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca cli cookie import', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves relative cookie import paths and dispatches browser.cookie.import', async () => {
    queueFixtures(
      callMock,
      okFixture('req_cookie_import', {
        ok: true,
        profileId: 'default',
        summary: {
          totalCookies: 2,
          importedCookies: 2,
          skippedCookies: 0,
          domains: ['example.com']
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['cookie', 'import', '--file', 'cookies.json', '--json'], '/tmp/cookie-import-cwd')

    expect(callMock).toHaveBeenCalledWith('browser.cookie.import', {
      file: path.resolve('/tmp/cookie-import-cwd', 'cookies.json')
    })
  })

  it('passes an explicit profile id through cookie import', async () => {
    queueFixtures(
      callMock,
      okFixture('req_cookie_import', {
        ok: true,
        profileId: 'profile-1',
        summary: {
          totalCookies: 1,
          importedCookies: 1,
          skippedCookies: 0,
          domains: ['example.com']
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['cookie', 'import', '--file', '/abs/cookies.json', '--profile', 'profile-1', '--json'],
      '/tmp/cookie-import-cwd'
    )

    expect(callMock).toHaveBeenCalledWith('browser.cookie.import', {
      file: '/abs/cookies.json',
      profileId: 'profile-1'
    })
  })

  it('surfaces bulk import failure reasons as CLI errors', async () => {
    queueFixtures(
      callMock,
      okFixture('req_cookie_import', {
        ok: false,
        reason: 'No valid cookies found. 2 entries were skipped due to missing or invalid fields.'
      })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['cookie', 'import', '--file', '/abs/cookies.json'], '/tmp/cookie-import-cwd')

    expect(errorSpy.mock.calls.flat().join('\n')).toContain('No valid cookies found')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
