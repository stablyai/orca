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

import { main } from '../index'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'

function mockStdin(chunks: string[]): { restore: () => void } {
  const stdin = process.stdin
  const previous = [
    ['isTTY', Object.getOwnPropertyDescriptor(stdin, 'isTTY')],
    [Symbol.asyncIterator, Object.getOwnPropertyDescriptor(stdin, Symbol.asyncIterator)]
  ] as const
  Object.defineProperty(stdin, 'isTTY', { configurable: true, value: false })
  Object.defineProperty(stdin, Symbol.asyncIterator, {
    configurable: true,
    value: async function* () {
      for (const chunk of chunks) {
        yield Buffer.from(chunk)
      }
    }
  })
  return {
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(stdin, key, descriptor)
        } else {
          Reflect.deleteProperty(stdin, key)
        }
      }
    }
  }
}

describe('orca fill --value-stdin', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockImplementation(async () => okFixture('req_fill', { filled: '@e3' }))
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('sends the stdin payload minus one trailing newline as the fill value', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stdin = mockStdin(['hunter', '2\n\r\n'])
    try {
      await main(
        ['fill', '--element', '@e3', '--value-stdin', '--page', 'page-1', '--json'],
        '/tmp/not-an-orca-worktree'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).toHaveBeenCalledWith(
      'browser.fill',
      expect.objectContaining({ element: '@e3', value: 'hunter2\n', page: 'page-1' })
    )
    expect(process.exitCode).toBeUndefined()
  })

  it.each([
    [['--value', 'secret', '--value-stdin'], 'Use either --value or --value-stdin, not both'],
    [['--value-stdin'], 'Missing value from stdin']
  ])('rejects %j before calling the runtime', async (valueFlags, message) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stdin = mockStdin(['\n'])
    try {
      await main(
        ['fill', '--element', '@e3', ...valueFlags, '--page', 'page-1'],
        '/tmp/not-an-orca-worktree'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalledWith('browser.fill', expect.anything())
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(message)
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('secret')
    expect(process.exitCode).toBe(1)
  })
})
