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
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from '../test-fixtures'

describe('orca computer action CLI routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  it('does not resolve worktree when --session is explicit', async () => {
    queueFixtures(callMock, okFixture('req_click', sampleSnapshot()))

    await main(
      [
        'computer',
        'click',
        '--session',
        'manual',
        '--app',
        'Finder',
        '--element-index',
        '3',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('computer.click', {
      session: 'manual',
      app: 'Finder',
      elementIndex: 3,
      x: undefined,
      y: undefined,
      clickCount: undefined,
      mouseButton: undefined,
      noScreenshot: undefined
    })
  })

  it('prints session and window context in action follow-up commands', async () => {
    queueFixtures(callMock, okFixture('req_click', sampleSnapshot()))

    await main(
      [
        'computer',
        'click',
        '--session',
        'manual',
        '--app',
        'Finder',
        '--element-index',
        '3',
        '--window-index',
        '1',
        '--restore-window'
      ],
      '/tmp/repo/src'
    )

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain(
      'Use `orca computer get-app-state --app com.apple.finder --session manual --window-index 1 --restore-window`'
    )
  })

  it('maps action command flags to RPC payloads', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'feature')]),
      okFixture('req_drag', sampleSnapshot())
    )

    await main(
      [
        'computer',
        'drag',
        '--app',
        'Finder',
        '--from-x',
        '1',
        '--from-y',
        '2',
        '--to-x',
        '3',
        '--to-y',
        '4',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'computer.drag', {
      app: 'Finder',
      worktree: 'id:repo::/tmp/repo',
      fromElementIndex: undefined,
      toElementIndex: undefined,
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      noScreenshot: undefined
    })
  })

  it('maps coordinate scroll flags to RPC payloads', async () => {
    queueFixtures(callMock, okFixture('req_scroll', sampleSnapshot()))

    await main(
      [
        'computer',
        'scroll',
        '--session',
        'manual',
        '--app',
        'Finder',
        '--x',
        '10',
        '--y',
        '20',
        '--direction',
        'down',
        '--pages',
        '0.5',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('computer.scroll', {
      session: 'manual',
      app: 'Finder',
      elementIndex: undefined,
      x: 10,
      y: 20,
      direction: 'down',
      pages: 0.5,
      noScreenshot: undefined
    })
  })

  it('maps hotkey and paste-text command flags to RPC payloads', async () => {
    queueFixtures(callMock, okFixture('req_hotkey', sampleSnapshot()))
    await main(
      [
        'computer',
        'hotkey',
        '--session',
        'manual',
        '--app',
        'Finder',
        '--key',
        'CmdOrCtrl+L',
        '--no-screenshot',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('computer.hotkey', {
      session: 'manual',
      app: 'Finder',
      key: 'CmdOrCtrl+L',
      noScreenshot: true
    })

    callMock.mockReset()
    vi.mocked(console.log).mockClear()
    queueFixtures(callMock, okFixture('req_paste', sampleSnapshot()))
    await main(
      [
        'computer',
        'paste-text',
        '--session',
        'manual',
        '--app',
        'Finder',
        '--text',
        'hello world',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('computer.pasteText', {
      session: 'manual',
      app: 'Finder',
      text: 'hello world',
      noScreenshot: undefined
    })
  })
})

function sampleSnapshot() {
  return {
    snapshot: {
      id: 'snap-test',
      app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
      window: { title: 'Finder', width: 800, height: 600 },
      coordinateSpace: 'window',
      truncation: { truncated: false, maxNodes: 1200, maxDepth: 64, maxDepthReached: false },
      treeText: 'App=com.apple.finder (pid 100)\n0 standard window Finder',
      elementCount: 1,
      focusedElementId: 0
    },
    screenshotStatus: { state: 'captured' }
  }
}
