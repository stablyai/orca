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
        '--modifiers',
        'CmdOrCtrl+Shift',
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
      modifiers: 'CmdOrCtrl+Shift',
      noScreenshot: undefined,
      treeDiff: true
    })
  })

  it('forwards a middle click to the runtime instead of silently downgrading it', async () => {
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
        '--mouse-button',
        'middle',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith(
      'computer.click',
      expect.objectContaining({ mouseButton: 'middle' })
    )
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

  it('asks for a tree diff unless --full-tree is passed', async () => {
    queueFixtures(callMock, okFixture('req_click', sampleSnapshot()))
    await main(
      ['computer', 'click', '--session', 'manual', '--app', 'Finder', '--element-index', '3'],
      '/tmp/repo/src'
    )
    expect(callMock).toHaveBeenLastCalledWith(
      'computer.click',
      expect.objectContaining({ treeDiff: true })
    )

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
        '--full-tree'
      ],
      '/tmp/repo/src'
    )
    expect(callMock.mock.lastCall?.[1]).not.toHaveProperty('treeDiff')
  })

  it('prints a returned tree diff after the action summary', async () => {
    const diffText = [
      'App=com.apple.finder (pid 100)',
      'Window: "Finder", App: Finder.',
      '',
      'Changes since the previous snapshot (~ changed, + added, - removed). Unchanged elements are omitted and keep their indexes.',
      '~ \t\t3 text field (settable) Search, Value: notes',
      '',
      'The focused UI element is 3 text field (settable) Search, Value: notes.'
    ].join('\n')
    const result = sampleSnapshot()
    queueFixtures(
      callMock,
      okFixture('req_click', {
        ...result,
        snapshot: {
          ...result.snapshot,
          treeText: diffText,
          treeDiff: { baseSnapshotId: 'snap-before', changed: 1, added: 0, removed: 0 }
        }
      })
    )

    await main(
      ['computer', 'click', '--session', 'manual', '--app', 'Finder', '--element-index', '3'],
      '/tmp/repo/src'
    )

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toMatch(/^Click attempted, unverified/u)
    expect(output).toContain(`\n\n${diffText}`)
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
      noScreenshot: undefined,
      treeDiff: true
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
      noScreenshot: undefined,
      treeDiff: true
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
      noScreenshot: true,
      treeDiff: true
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
      noScreenshot: undefined,
      treeDiff: true
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
