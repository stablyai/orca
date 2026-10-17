import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', async () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  // Why: format.ts narrows with `instanceof`, so the mock must re-export the real error classes.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')
  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from './index'
import { mockStdin, okFixture, queueFixtures } from './test-fixtures'

const FILL_STDIN_ARGS = ['fill', '--element', '@e1', '--value-stdin', '--worktree', 'all']

async function runWithStdin(
  isTTY: boolean,
  chunks: string[],
  args: string[]
): Promise<{ stdinWasRead: boolean }> {
  const stdin = mockStdin(isTTY, chunks)
  try {
    await main(args, '/tmp/not-an-orca-worktree')
  } finally {
    stdin.restore()
  }
  return { stdinWasRead: stdin.wasRead() }
}

function errorOutput(): string {
  return vi.mocked(console.error).mock.calls.flat().join('\n')
}

describe('orca fill --value-stdin', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  it.each([
    ['a trailing LF', ['dummy-pa', 'ss wörd\n'], 'dummy-pass wörd'],
    ['a trailing CRLF', ['dummy-pass\r\n'], 'dummy-pass'],
    ['only one of several trailing newlines', ['line one\nline two\n\n'], 'line one\nline two\n'],
    ['no trailing newline', ['dummy-pass'], 'dummy-pass']
  ])('sends stdin as the browser.fill value, dropping %s', async (_case, chunks, expected) => {
    queueFixtures(callMock, okFixture('req_fill', { filled: '@e1' }))

    await runWithStdin(false, chunks, [...FILL_STDIN_ARGS, '--json'])

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.fill', {
      element: '@e1',
      value: expected,
      worktree: undefined
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('rejects --value combined with --value-stdin without reading stdin', async () => {
    const { stdinWasRead } = await runWithStdin(
      false,
      ['ignored'],
      [...FILL_STDIN_ARGS, '--value', 'dummy']
    )

    expect(stdinWasRead).toBe(false)
    expect(callMock).not.toHaveBeenCalled()
    expect(errorOutput()).toContain('Use either --value or --value-stdin, not both')
    expect(process.exitCode).toBe(1)
  })

  it('rejects --value-stdin=<text> without reading stdin or echoing the text', async () => {
    const { stdinWasRead } = await runWithStdin(
      false,
      ['ignored'],
      ['fill', '--element', '@e1', '--value-stdin=dummy-secret', '--worktree', 'all']
    )

    expect(stdinWasRead).toBe(false)
    expect(callMock).not.toHaveBeenCalled()
    expect(errorOutput()).toContain('--value-stdin takes no value; pipe the value on stdin')
    expect(errorOutput()).not.toContain('dummy-secret')
    expect(process.exitCode).toBe(1)
  })

  it('names both forms when neither --value nor --value-stdin is given', async () => {
    await main(['fill', '--element', '@e1', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(callMock).not.toHaveBeenCalled()
    expect(errorOutput()).toContain('Missing --value or --value-stdin')
    expect(process.exitCode).toBe(1)
  })

  it('rejects an interactive stdin instead of waiting for typed input', async () => {
    await runWithStdin(true, [], FILL_STDIN_ARGS)

    expect(callMock).not.toHaveBeenCalled()
    expect(errorOutput()).toContain('stdin payload requested but stdin is a TTY')
    expect(process.exitCode).toBe(1)
  })

  // Why: a failed secret reader pipes nothing; filling '' would silently clear the field.
  it.each([
    ['empty', []],
    ['newline-only', ['\n']]
  ])('rejects %s stdin like an empty --value', async (_case, chunks) => {
    await runWithStdin(false, chunks, FILL_STDIN_ARGS)

    expect(callMock).not.toHaveBeenCalled()
    expect(errorOutput()).toContain('Missing value from stdin')
    expect(process.exitCode).toBe(1)
  })
})
