import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', () => {
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

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca computer action CLI validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  it('rejects conflicting session and worktree computer targets before resolving worktree', async () => {
    await main(
      [
        'computer',
        'get-app-state',
        '--session',
        'manual',
        '--worktree',
        'active',
        '--app',
        'Finder'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    const output = vi.mocked(console.error).mock.calls[0][0]
    expect(output).toContain(
      'Computer-use targeting accepts either --session or --worktree, not both'
    )
    expect(output).toContain('Next step: Do not retry the same command unchanged.')
    expect(process.exitCode).toBe(1)
  })

  it('rejects actions without an app before resolving a worktree', async () => {
    await main(['computer', 'click', '--element-index', '1'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Missing required --app')
    expect(process.exitCode).toBe(1)
  })

  it('does not mask missing app with action target errors', async () => {
    await main(['computer', 'click'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Missing required --app')
    expect(process.exitCode).toBe(1)
  })

  it('rejects malformed hotkeys before calling the runtime', async () => {
    await main(
      ['computer', 'hotkey', '--app', 'Finder', '--key', 'Return', '--json'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Hotkey requires a modifier and one key')
    })
    expect(output.error.data.nextSteps).toEqual(
      expect.arrayContaining([expect.stringContaining('Do not retry the same command unchanged')])
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects modifier chords on press-key before calling the runtime', async () => {
    await main(
      ['computer', 'press-key', '--app', 'Finder', '--key', 'CmdOrCtrl+V', '--json'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Press-key accepts one key only')
    })
    expect(output.error.data.nextSteps).toEqual(
      expect.arrayContaining([expect.stringContaining('Do not retry the same command unchanged')])
    )
    expect(process.exitCode).toBe(1)
  })

  it('allows literal plus as a press-key key', async () => {
    queueFixtures(
      callMock,
      okFixture('req_press_key', {
        snapshot: {
          id: 'snap-1',
          app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
          window: { title: 'Finder', id: 1, width: 800, height: 600 },
          coordinateSpace: 'window',
          treeText: 'tree',
          elementCount: 1,
          focusedElementId: null
        },
        screenshot: null,
        screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
        action: {
          path: 'synthetic',
          actionName: 'pressKey',
          verification: { state: 'unverified', reason: 'synthetic_input' }
        }
      })
    )

    await main(
      [
        'computer',
        'press-key',
        '--session',
        'manual',
        '--app',
        'Finder',
        '--key',
        '+',
        '--no-screenshot'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('computer.pressKey', {
      session: 'manual',
      app: 'Finder',
      key: '+',
      noScreenshot: true
    })
    expect(vi.mocked(console.error)).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('rejects conflicting get-app-state window target flags before calling the runtime', async () => {
    await main(
      [
        'computer',
        'get-app-state',
        '--app',
        'Finder',
        '--window-id',
        '42',
        '--window-index',
        '0',
        '--no-screenshot'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'either --window-id or --window-index'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid window ids before calling the runtime', async () => {
    await main(
      ['computer', 'get-app-state', '--app', 'Finder', '--window-id', '1.5', '--json'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Invalid non-negative integer for --window-id')
    })
    expect(process.exitCode).toBe(1)
  })

  it('rejects conflicting action window target flags before calling the runtime', async () => {
    await main(
      [
        'computer',
        'click',
        '--app',
        'Finder',
        '--element-index',
        '1',
        '--window-id',
        '42',
        '--window-index',
        '0',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('either --window-id or --window-index')
    })
    expect(process.exitCode).toBe(1)
  })

  it('rejects invalid action flags before resolving the runtime target', async () => {
    await main(
      ['computer', 'click', '--app', 'Finder', '--element-index', '1', '--click-count', '0'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Invalid positive integer for --click-count'
    )
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Next step: Fix the command flags or RPC params exactly as described by the error message.'
    )
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Next step: Do not retry the same command unchanged.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('returns structured recovery data for local computer action flag errors in JSON mode', async () => {
    await main(
      [
        'computer',
        'click',
        '--app',
        'Finder',
        '--element-index',
        '1',
        '--click-count',
        '0',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0]) as {
      error: { code: string; message: string; data?: { nextSteps?: string[] } }
    }
    expect(output.error.code).toBe('invalid_argument')
    expect(output.error.message).toContain('Invalid positive integer for --click-count')
    expect(output.error.data?.nextSteps).toEqual([
      expect.stringContaining('Fix the command flags'),
      expect.stringContaining('Do not retry')
    ])
    expect(process.exitCode).toBe(1)
  })

  it('rejects incomplete pointer action targets before resolving the runtime target', async () => {
    await main(['computer', 'click', '--app', 'Finder', '--x', '10'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Click requires --element-index or both --x and --y'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects unsupported action option values before resolving the runtime target', async () => {
    await main(
      ['computer', 'click', '--app', 'Finder', '--element-index', '1', '--mouse-button', 'primary'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Unsupported --mouse-button')
    expect(process.exitCode).toBe(1)

    vi.mocked(console.error).mockClear()
    process.exitCode = undefined

    await main(
      ['computer', 'scroll', '--app', 'Finder', '--element-index', '1', '--direction', 'diagonal'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Unsupported --direction')
    expect(process.exitCode).toBe(1)
  })

  it('rejects incomplete drag targets before resolving the runtime target', async () => {
    await main(
      ['computer', 'drag', '--app', 'Finder', '--from-element-index', '1'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Drag element targeting requires both --from-element-index and --to-element-index'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects conflicting text payload flags before resolving the runtime target', async () => {
    await main(
      ['computer', 'type-text', '--app', 'Finder', '--text', 'hello', '--text-stdin'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Use either --text or --text-stdin')
    expect(process.exitCode).toBe(1)
  })

  it('rejects empty stdin for text actions before calling the runtime', async () => {
    const stdin = mockStdin(false, [])
    try {
      await main(['computer', 'paste-text', '--app', 'Finder', '--text-stdin'], '/tmp/repo/src')
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Missing text from stdin')
    expect(process.exitCode).toBe(1)
  })

  it('allows empty stdin for set-value so fields can be cleared', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_value', {
        snapshot: {
          id: 'snap-1',
          app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
          window: { title: 'Finder', id: 1, width: 800, height: 600 },
          coordinateSpace: 'window',
          treeText: 'tree',
          elementCount: 1,
          focusedElementId: null
        },
        screenshot: null,
        screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
        action: {
          path: 'accessibility',
          actionName: 'setValue',
          verification: {
            state: 'verified',
            property: 'value',
            expected: '',
            actualPreview: ''
          }
        }
      })
    )
    const stdin = mockStdin(false, [])
    try {
      await main(
        [
          'computer',
          'set-value',
          '--session',
          'manual',
          '--app',
          'Finder',
          '--element-index',
          '1',
          '--value-stdin',
          '--no-screenshot'
        ],
        '/tmp/repo/src'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).toHaveBeenCalledWith('computer.setValue', {
      session: 'manual',
      app: 'Finder',
      elementIndex: 1,
      value: '',
      noScreenshot: true
    })
    expect(vi.mocked(console.error)).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})

function mockStdin(isTTY: boolean, chunks: string[]): { restore: () => void } {
  const stdin = process.stdin as typeof process.stdin & {
    isTTY?: boolean
  }
  const previousIsTTY = stdin.isTTY
  const previousAsyncIterator = stdin[Symbol.asyncIterator]
  Object.defineProperty(stdin, 'isTTY', {
    configurable: true,
    value: isTTY
  })
  ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk)
    }
  }
  return {
    restore: () => {
      Object.defineProperty(stdin, 'isTTY', {
        configurable: true,
        value: previousIsTTY
      })
      if (previousAsyncIterator) {
        ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = previousAsyncIterator
      } else {
        Reflect.deleteProperty(stdin, Symbol.asyncIterator)
      }
    }
  }
}
