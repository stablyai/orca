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
  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { BROWSER_EXPECT_URL_RUNTIME_CAPABILITY } from '../../shared/browser-runtime-capabilities'
import { RPC_PARAMS_BY_METHOD } from '../../shared/rpc-contract/rpc-params-catalog.generated'
import { main } from '../index'
import { BROWSER_ADVANCED_COMMAND_SPECS } from '../specs/browser-advanced'
import { BROWSER_BASIC_COMMAND_SPECS } from '../specs/browser-basic'
import { okFixture } from '../test-fixtures'

const EXPECT_URL = 'https://example.com/chat/a'

// Every guarded command, with arguments that reach its RPC and the RPC it must carry the URL on.
const GUARDED_COMMANDS: Record<
  string,
  { args: string[]; method: keyof typeof RPC_PARAMS_BY_METHOD }
> = {
  back: { args: [], method: 'browser.back' },
  check: { args: ['--element', '@e1'], method: 'browser.check' },
  clear: { args: ['--element', '@e1'], method: 'browser.clear' },
  click: { args: ['--element', '@e1'], method: 'browser.click' },
  dblclick: { args: ['--element', '@e1'], method: 'browser.dblclick' },
  'dialog accept': { args: [], method: 'browser.dialogAccept' },
  'dialog dismiss': { args: [], method: 'browser.dialogDismiss' },
  download: { args: ['--selector', '@e1', '--path', '/tmp/f'], method: 'browser.download' },
  drag: { args: ['--from', '@e1', '--to', '@e2'], method: 'browser.drag' },
  eval: { args: ['--expression', '1'], method: 'browser.eval' },
  fill: { args: ['--element', '@e1', '--value', 'x'], method: 'browser.fill' },
  find: {
    args: ['--locator', 'role', '--value', 'button', '--action', 'click'],
    method: 'browser.find'
  },
  focus: { args: ['--element', '@e1'], method: 'browser.focus' },
  forward: { args: [], method: 'browser.forward' },
  goto: { args: ['--url', 'https://example.com/b'], method: 'browser.goto' },
  hover: { args: ['--element', '@e1'], method: 'browser.hover' },
  inserttext: { args: ['--text', 'x'], method: 'browser.keyboardInsertText' },
  keypress: { args: ['--key', 'Enter'], method: 'browser.keypress' },
  'mouse down': { args: [], method: 'browser.mouseDown' },
  'mouse move': { args: ['--x', '1', '--y', '2'], method: 'browser.mouseMove' },
  'mouse up': { args: [], method: 'browser.mouseUp' },
  'mouse wheel': { args: ['--dy', '1'], method: 'browser.mouseWheel' },
  reload: { args: [], method: 'browser.reload' },
  scroll: { args: ['--direction', 'down'], method: 'browser.scroll' },
  scrollintoview: { args: ['--element', '@e1'], method: 'browser.scrollIntoView' },
  select: { args: ['--element', '@e1', '--value', 'x'], method: 'browser.select' },
  'select-all': { args: ['--element', '@e1'], method: 'browser.selectAll' },
  'storage local clear': { args: [], method: 'browser.storage.local.clear' },
  'storage local set': {
    args: ['--key', 'k', '--value', 'v'],
    method: 'browser.storage.local.set'
  },
  'storage session clear': { args: [], method: 'browser.storage.session.clear' },
  'storage session set': {
    args: ['--key', 'k', '--value', 'v'],
    method: 'browser.storage.session.set'
  },
  type: { args: ['--input', 'x'], method: 'browser.type' },
  uncheck: { args: ['--element', '@e1'], method: 'browser.check' },
  upload: { args: ['--element', '@e1', '--files', '/tmp/f'], method: 'browser.upload' }
}

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

  it('is offered by exactly the commands that carry it', () => {
    const offered = [...BROWSER_BASIC_COMMAND_SPECS, ...BROWSER_ADVANCED_COMMAND_SPECS]
      .filter((spec) => spec.allowedFlags.includes('expect-url'))
      .map((spec) => spec.path.join(' '))
    expect(offered.sort()).toEqual(Object.keys(GUARDED_COMMANDS).sort())
  })

  it.each(Object.entries(GUARDED_COMMANDS))(
    '%s sends the URL on an RPC whose schema keeps it',
    async (path, { args, method }) => {
      answerRuntime([BROWSER_EXPECT_URL_RUNTIME_CAPABILITY])

      await main(
        [...path.split(' '), ...args, '--page', 'page-1', '--expect-url', EXPECT_URL, '--json'],
        '/tmp/not-an-orca-worktree'
      )

      const call = callMock.mock.calls.find(([called]) => called === method)
      expect(call?.[1]).toMatchObject({ page: 'page-1', expectUrl: EXPECT_URL })
      expect(RPC_PARAMS_BY_METHOD[method].parse(call?.[1])).toMatchObject({
        expectUrl: EXPECT_URL
      })
    }
  )

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

  it('asks the runtime nothing extra without the flag', async () => {
    answerRuntime(['runtime.v1'])

    await main(['click', '--element', '@e1', '--page', 'page-1', '--json'], '/tmp/not-a-worktree')

    expect(callMock.mock.calls).toEqual([['browser.click', { element: '@e1', page: 'page-1' }]])
  })
})
