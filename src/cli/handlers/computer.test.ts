/* eslint-disable max-lines -- Why: computer CLI coverage shares one mocked runtime setup across command contracts. */
import path from 'path'
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

describe('orca computer CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('prints group help with all computer subcommands', async () => {
    await main(['computer', '--help'], '/tmp/repo')

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('get-app-state')
    expect(output).toContain('hotkey')
    expect(output).toContain('capabilities')
    expect(output).toContain('list-apps')
    expect(output).toContain('list-windows')
    expect(output).toContain('paste-text')
    expect(output).toContain('permissions')
    expect(output).toContain('set-value')
  })

  it('passes list-apps through with a resolved worktree', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'feature')]),
      okFixture('req_apps', { apps: [] })
    )

    await main(['computer', 'list-apps', '--json'], '/tmp/repo/src')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'computer.listApps', {
      worktree: `path:${path.resolve('/tmp/repo')}`
    })
  })

  it('prints provider capabilities without resolving a worktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_capabilities', {
        platform: 'darwin',
        provider: 'orca-computer-use-macos',
        providerVersion: '1.0.0',
        protocolVersion: 1,
        supports: {
          apps: { list: true, bundleIds: true, pids: true },
          windows: { list: true, targetById: true, targetByIndex: true },
          observation: { screenshot: true, elementFrames: true, annotatedScreenshot: false },
          actions: { click: true, setValue: true, pasteText: true },
          surfaces: {}
        }
      })
    )

    await main(['computer', 'capabilities'], '/tmp/repo/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('computer.capabilities', {})
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain('orca-computer-use-macos')
  })

  it('opens computer permission setup without resolving a worktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_permissions', {
        platform: 'darwin',
        helperAppPath: '/Applications/Orca Computer Use.app',
        openedSettings: false,
        launchedHelper: true
      })
    )

    await main(['computer', 'permissions'], '/tmp/repo/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('computer.permissions', {})
    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('Opened Orca Computer Use permission setup')
    expect(output).toContain('/Applications/Orca Computer Use.app')
  })

  it('passes get-app-state target and observe flags', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'feature')]),
      okFixture('req_state', sampleSnapshot())
    )

    await main(
      [
        'computer',
        'get-app-state',
        '--app',
        'Finder',
        '--no-screenshot',
        '--restore-window',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'computer.getAppState', {
      app: 'Finder',
      worktree: `path:${path.resolve('/tmp/repo')}`,
      noScreenshot: true,
      restoreWindow: true
    })
  })

  it('passes list-windows target and formats window IDs', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'feature')]),
      okFixture('req_windows', {
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        windows: [
          {
            app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
            index: 0,
            id: 42,
            title: 'Recents',
            x: 10,
            y: 20,
            width: 800,
            height: 600,
            isMinimized: false,
            isOffscreen: false,
            screenIndex: 0
          }
        ]
      })
    )

    await main(['computer', 'list-windows', '--app', 'Finder'], '/tmp/repo/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'computer.listWindows', {
      app: 'Finder',
      worktree: `path:${path.resolve('/tmp/repo')}`
    })
    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('[0] id:42 "Recents"')
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
      worktree: `path:${path.resolve('/tmp/repo')}`,
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

  it('formats get-app-state without printing screenshot bytes in pretty mode', async () => {
    queueFixtures(callMock, okFixture('req_state', sampleSnapshot()))

    await main(['computer', 'get-app-state', '--session', 'manual', '--app', 'Finder'], '/tmp/repo')

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('Finder (pid 100, com.apple.finder)')
    expect(output).toContain('App=com.apple.finder')
    expect(output).not.toContain('base64-data')
  })

  it('omits screenshot bytes from JSON output and writes a screenshot path', async () => {
    queueFixtures(callMock, okFixture('req_state', sampleSnapshot()))

    await main(
      ['computer', 'get-app-state', '--session', 'manual', '--app', 'Finder', '--json'],
      '/tmp/repo'
    )

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).not.toContain('base64-data')
    const parsed = JSON.parse(output)
    expect(parsed.result.screenshot).toMatchObject({
      dataOmitted: true,
      format: 'png',
      expiresAt: expect.any(String)
    })
    expect(String(parsed.result.screenshot.path).replaceAll('\\', '/')).toContain(
      'orca-computer-use/req_state-screenshot.png'
    )
  })

  it('shows coordinate space and truncation in pretty state output', async () => {
    queueFixtures(callMock, okFixture('req_state', sampleSnapshot()))

    await main(['computer', 'get-app-state', '--session', 'manual', '--app', 'Finder'], '/tmp/repo')

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('Coordinates: window')
    expect(output).toContain('Truncated: no')
  })

  it('passes get-app-state window target flags through', async () => {
    queueFixtures(callMock, okFixture('req_snapshot', sampleSnapshot()))

    await main(
      [
        'computer',
        'get-app-state',
        '--session',
        'manual',
        '--app',
        'Finder',
        '--window-id',
        '42',
        '--window-index',
        '0',
        '--no-screenshot',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('computer.getAppState', {
      session: 'manual',
      app: 'Finder',
      noScreenshot: true,
      restoreWindow: undefined,
      windowId: 42,
      windowIndex: 0
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
    screenshot: {
      data: 'base64-data',
      format: 'png',
      width: 800,
      height: 600,
      scale: 1
    },
    screenshotStatus: { state: 'captured' }
  }
}
