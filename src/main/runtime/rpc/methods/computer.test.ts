import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRegistry } from '../core'
import { CLIPBOARD_TEXT_WRITE_MAX_BYTES } from '../../../../shared/clipboard-text'

const computerMocks = vi.hoisted(() => ({
  callComputerSidecarAction: vi.fn(),
  callComputerSidecarCapabilities: vi.fn(),
  callComputerSidecarListApps: vi.fn(),
  callComputerSidecarListWindows: vi.fn(),
  callComputerSidecarSnapshot: vi.fn(),
  resetComputerSidecarForTest: vi.fn(),
  openComputerUsePermissions: vi.fn(),
  getComputerUsePermissionStatus: vi.fn()
}))

vi.mock('../../../computer/sidecar-client', () => ({
  callComputerSidecarAction: computerMocks.callComputerSidecarAction,
  callComputerSidecarCapabilities: computerMocks.callComputerSidecarCapabilities,
  callComputerSidecarListApps: computerMocks.callComputerSidecarListApps,
  callComputerSidecarListWindows: computerMocks.callComputerSidecarListWindows,
  callComputerSidecarSnapshot: computerMocks.callComputerSidecarSnapshot,
  resetComputerSidecarForTest: computerMocks.resetComputerSidecarForTest
}))

vi.mock('../../../computer/macos-computer-use-permissions', () => ({
  openComputerUsePermissions: computerMocks.openComputerUsePermissions,
  getComputerUsePermissionStatus: computerMocks.getComputerUsePermissionStatus
}))

import { COMPUTER_METHODS, resetComputerSessionsForTest } from './computer'

describe('computer RPC methods', () => {
  beforeEach(() => {
    computerMocks.callComputerSidecarAction.mockReset()
    computerMocks.callComputerSidecarCapabilities.mockReset()
    computerMocks.callComputerSidecarListApps.mockReset()
    computerMocks.callComputerSidecarListWindows.mockReset()
    computerMocks.callComputerSidecarSnapshot.mockReset()
    computerMocks.resetComputerSidecarForTest.mockReset()
    computerMocks.openComputerUsePermissions.mockReset()
    computerMocks.getComputerUsePermissionStatus.mockReset()
    resetComputerSessionsForTest()
    computerMocks.resetComputerSidecarForTest.mockClear()
  })

  it('registers all computer methods', () => {
    const registry = buildRegistry(COMPUTER_METHODS)

    expect([...registry.keys()].sort()).toEqual([
      'computer.capabilities',
      'computer.click',
      'computer.drag',
      'computer.getAppState',
      'computer.hotkey',
      'computer.listApps',
      'computer.listWindows',
      'computer.pasteText',
      'computer.performSecondaryAction',
      'computer.permissions',
      'computer.permissionsStatus',
      'computer.pressKey',
      'computer.scroll',
      'computer.setValue',
      'computer.typeText'
    ])
  })

  it('resets the sidecar test process', () => {
    resetComputerSessionsForTest()

    expect(computerMocks.resetComputerSidecarForTest).toHaveBeenCalledTimes(1)
  })

  it('lists running apps through the sidecar', async () => {
    const result = {
      apps: [{ name: 'Finder', bundleId: 'com.apple.finder', pid: 100 }]
    }
    computerMocks.callComputerSidecarListApps.mockResolvedValue(result)

    await expect(call('computer.listApps', {})).resolves.toBe(result)
    expect(computerMocks.callComputerSidecarListApps).toHaveBeenCalledWith()
  })

  it('rejects ignored listApps scoping params', () => {
    expect(() =>
      findMethod('computer.listApps').params!.parse({ worktree: 'path:/tmp/repo' })
    ).toThrow()
  })

  it('returns provider capabilities through the sidecar', async () => {
    const result = { platform: 'darwin', provider: 'orca-computer-use-macos', protocolVersion: 1 }
    computerMocks.callComputerSidecarCapabilities.mockResolvedValue(result)

    await expect(call('computer.capabilities', {})).resolves.toBe(result)
    expect(computerMocks.callComputerSidecarCapabilities).toHaveBeenCalledWith()
  })

  it('opens computer-use permission setup', async () => {
    const result = {
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      openedSettings: false,
      launchedHelper: true
    }
    computerMocks.openComputerUsePermissions.mockReturnValue(result)

    await expect(call('computer.permissions', { id: 'accessibility' })).resolves.toBe(result)
    expect(computerMocks.openComputerUsePermissions).toHaveBeenCalledWith('accessibility')
  })

  it('returns computer-use permission status', async () => {
    const result = {
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      helperUnavailableReason: null,
      permissions: [{ id: 'accessibility', status: 'granted' }]
    }
    computerMocks.getComputerUsePermissionStatus.mockReturnValue(result)

    await expect(call('computer.permissionsStatus', {})).resolves.toBe(result)
    expect(computerMocks.getComputerUsePermissionStatus).toHaveBeenCalledWith()
  })

  it('lists windows through the sidecar', async () => {
    const result = {
      app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
      windows: []
    }
    const params = { app: 'Finder' }
    computerMocks.callComputerSidecarListWindows.mockResolvedValue(result)

    await expect(call('computer.listWindows', params)).resolves.toBe(result)
    expect(computerMocks.callComputerSidecarListWindows).toHaveBeenCalledWith(params)
  })

  it('rejects ignored listWindows scoping params', () => {
    expect(() =>
      findMethod('computer.listWindows').params!.parse({
        app: 'Finder',
        session: 'manual'
      })
    ).toThrow()
    expect(() =>
      findMethod('computer.listWindows').params!.parse({
        app: 'Finder',
        worktree: 'path:/tmp/repo'
      })
    ).toThrow()
  })

  it('gets app state through the sidecar', async () => {
    const snapshot = {
      snapshot: {
        id: 'snap-test',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Finder', width: 100, height: 100 },
        treeText: 'tree',
        elementCount: 1,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
    }
    const params = {
      app: 'Finder',
      worktree: 'path:/tmp/repo',
      noScreenshot: true,
      restoreWindow: true,
      windowId: 123
    }
    computerMocks.callComputerSidecarSnapshot.mockResolvedValue(snapshot)

    await expect(call('computer.getAppState', params)).resolves.toBe(snapshot)
    expect(computerMocks.callComputerSidecarSnapshot).toHaveBeenCalledWith(params)
  })

  it('rejects missing app in getAppState schema', () => {
    const method = findMethod('computer.getAppState')
    expect(() => method.params!.parse({})).toThrow()
  })

  it('rejects ambiguous window targeting', () => {
    expect(() =>
      findMethod('computer.getAppState').params!.parse({
        app: 'Finder',
        windowId: 1,
        windowIndex: 0
      })
    ).toThrow(/either --window-id or --window-index/)
    expect(() =>
      findMethod('computer.click').params!.parse({
        app: 'Finder',
        elementIndex: 0,
        windowId: 1,
        windowIndex: 0
      })
    ).toThrow(/either --window-id or --window-index/)
  })

  it('rejects ambiguous session and worktree targeting', () => {
    expect(() =>
      findMethod('computer.getAppState').params!.parse({
        app: 'Finder',
        session: 'manual',
        worktree: 'id:repo::/tmp/repo'
      })
    ).toThrow(/either session or worktree/)
    expect(() =>
      findMethod('computer.click').params!.parse({
        app: 'Finder',
        session: 'manual',
        worktree: 'id:repo::/tmp/repo',
        elementIndex: 0
      })
    ).toThrow(/either session or worktree/)
  })

  it('treats empty computer-use worktree scope as absent', () => {
    expect(
      findMethod('computer.getAppState').params!.parse({
        app: 'Finder',
        worktree: ''
      })
    ).toMatchObject({
      app: 'Finder',
      worktree: undefined
    })
  })

  it('rejects malformed hotkey specs before dispatch', () => {
    expect(() =>
      findMethod('computer.hotkey').params!.parse({ app: 'Finder', key: 'Return' })
    ).toThrow(/Hotkey requires a modifier and one key/)
    expect(() =>
      findMethod('computer.hotkey').params!.parse({ app: 'Finder', key: 'CmdOrCtrl+Shift' })
    ).toThrow(/Hotkey requires a modifier and one key/)
    expect(() =>
      findMethod('computer.hotkey').params!.parse({ app: 'Finder', key: 'Ctrl+A+B' })
    ).toThrow(/Hotkey requires a modifier and one key/)
  })

  it('leaves pasteText byte limits to async sidecar validation', () => {
    const text = 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)

    expect(
      findMethod('computer.pasteText').params!.safeParse({ app: 'Finder', text }).success
    ).toBe(true)
  })
})

function findMethod(name: string) {
  const method = COMPUTER_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`missing method ${name}`)
  }
  return method
}

async function call(name: string, params: Record<string, unknown>) {
  const method = findMethod(name)
  const parsed = method.params ? method.params.parse(params) : undefined
  return await method.handler(parsed, {
    runtime: { getRuntimeId: () => 'runtime-1' } as never
  })
}
