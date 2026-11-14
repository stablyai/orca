import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, runtimeClientConstructorMock, serveOrcaAppMock, getDefaultUserDataPathMock } =
  vi.hoisted(() => ({
    callMock: vi.fn(),
    runtimeClientConstructorMock: vi.fn(),
    serveOrcaAppMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('../runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('../runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

import { BROWSER_EXPECT_URL_RUNTIME_CAPABILITY } from '../../shared/browser/runtime/browser-runtime-capabilities'

import { main } from '../index'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'

const EXPECT_URL = 'https://example.com/chat/a'

// Every guarded command, with arguments that reach its RPC and the RPC it must carry the URL on.

function answerRuntime(capabilities: string[]): void {
  callMock.mockImplementation(async (method: string) =>
    method === 'status.get'
      ? okFixture('status', { capabilities })
      : okFixture('result', { done: true })
  )
}

describe('--expect-url', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('refuses before acting when the runtime would drop the field', async () => {
    answerRuntime(['runtime.v1'])

    await main(
      ['click', '--element', '@e1', '--page', 'page-1', '--expect-url', EXPECT_URL, '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    expect(process.exitCode).toBe(1)
  })

  it.each([[''], [undefined]])(
    'refuses an empty value (%s) rather than run unguarded',
    async (value) => {
      answerRuntime([BROWSER_EXPECT_URL_RUNTIME_CAPABILITY])

      await main(
        [
          'click',
          '--element',
          '@e1',
          '--page',
          'page-1',
          '--json',
          '--expect-url',
          ...(value === undefined ? [] : [value])
        ],
        '/tmp/not-an-orca-worktree'
      )

      expect(callMock).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
    }
  )
})
