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

describe('orca computer observation CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
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
    expect(output).toContain('press-key')
    expect(output).toContain('Press a single key such as Return or Escape')
    expect(output).not.toContain(['Press a key using', 'xdotool-style syntax'].join(' '))
  })

  it('prints targeted permission setup command help', async () => {
    await main(['computer', 'permissions', '--help'], '/tmp/repo')

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain(
      'orca computer permissions [--id <accessibility|screenshots>] [--json]'
    )
    expect(output).toContain('--id <id>')
    expect(output).toContain('Identifier for a target item or permission')
  })

  it('prints command-specific keyboard action help', async () => {
    await main(['computer', 'hotkey', '--help'], '/tmp/repo')

    const hotkeyOutput = vi.mocked(console.log).mock.calls[0][0]
    expect(hotkeyOutput).toContain('--key <key-combo>')
    expect(hotkeyOutput).toContain('Modifier chord with one key')
    expect(hotkeyOutput).not.toContain('CmdOrCtrl+L')

    vi.mocked(console.log).mockClear()
    await main(['computer', 'press-key', '--help'], '/tmp/repo')

    const pressKeyOutput = vi.mocked(console.log).mock.calls[0][0]
    expect(pressKeyOutput).toContain('--key <key>')
    expect(pressKeyOutput).toContain('Single key, e.g. Return, Escape, Tab, Left, or PageUp')
  })

  it('passes list-apps through without resolving a worktree', async () => {
    queueFixtures(callMock, okFixture('req_apps', { apps: [] }))

    await main(['computer', 'list-apps', '--json'], '/tmp/repo/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('computer.listApps', {})
  })

  it('rejects ignored list-apps worktree scoping before calling the runtime', async () => {
    await main(['computer', 'list-apps', '--worktree', 'active'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Unknown flag --worktree for command: computer list-apps'
    )
    expect(process.exitCode).toBe(1)
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

  it('passes targeted computer permission setup id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_permissions', {
        platform: 'darwin',
        helperAppPath: '/Applications/Orca Computer Use.app',
        openedSettings: true,
        launchedHelper: true
      })
    )

    await main(['computer', 'permissions', '--id', 'screenshots'], '/tmp/repo/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('computer.permissions', { id: 'screenshots' })
  })

  it('rejects invalid computer permission setup id before calling the runtime', async () => {
    await main(['computer', 'permissions', '--id', 'screen'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    const output = vi.mocked(console.error).mock.calls[0][0]
    expect(output).toContain('--id must be "accessibility" or "screenshots"')
    expect(output).toContain('Next step: Do not retry the same command unchanged.')
    expect(process.exitCode).toBe(1)
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
      worktree: 'id:repo::/tmp/repo',
      noScreenshot: true,
      restoreWindow: true
    })
  })

  it('rejects get-app-state without an app before resolving a worktree', async () => {
    await main(['computer', 'get-app-state', '--json'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing required --app')
    })
    expect(process.exitCode).toBe(1)
  })

  it('passes list-windows target and formats window IDs', async () => {
    queueFixtures(
      callMock,
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

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('computer.listWindows', { app: 'Finder' })
    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('[0] id:42 "Recents"')
  })

  it('rejects list-windows without an app before calling the runtime', async () => {
    await main(['computer', 'list-windows'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Missing required --app')
    expect(process.exitCode).toBe(1)
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
