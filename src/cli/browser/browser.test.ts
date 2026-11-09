import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    userDataPath = '/tmp/orca-dev-profile'
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

describe('orca cli browser page targeting', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('saves screenshots where the CLI runs and prints the path instead of base64', async () => {
    const screenshotDir = mkdtempSync(join(tmpdir(), 'orca-browser-shot-'))
    vi.stubEnv('ORCA_BROWSER_SCREENSHOT_TMPDIR', screenshotDir)
    queueFixtures(
      callMock,
      okFixture('req_shot', { data: Buffer.from('png-bytes').toString('base64'), format: 'png' }),
      okFixture('req_unchanged', { data: '', format: 'png', changed: false })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await main(['screenshot', '--page', 'page-1', '--json'], '/tmp/not-an-orca-worktree')
      await main(['screenshot', '--page', 'page-1', '--if-changed'], '/tmp/not-an-orca-worktree')

      const saved = JSON.parse(String(log.mock.calls[0][0])).result
      expect(saved.data).toBeUndefined()
      expect(saved.path).toBe(join(screenshotDir, 'req_shot-screenshot.png'))
      expect(readFileSync(saved.path, 'utf8')).toBe('png-bytes')
      expect(callMock).toHaveBeenLastCalledWith('browser.screenshot', {
        page: 'page-1',
        ifChanged: true
      })
      expect(log).toHaveBeenLastCalledWith(
        'Screenshot unchanged since the last --if-changed capture; nothing saved'
      )
    } finally {
      rmSync(screenshotDir, { recursive: true, force: true })
    }
  })
})
