/* eslint-disable max-lines -- Why: computer RPC coverage shares one mocked registry setup across all method contracts. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRegistry } from '../core'

const computerMocks = vi.hoisted(() => ({
  callComputerSidecarAction: vi.fn(),
  callComputerSidecarCapabilities: vi.fn(),
  callComputerSidecarListApps: vi.fn(),
  callComputerSidecarListWindows: vi.fn(),
  callComputerSidecarSnapshot: vi.fn(),
  resetComputerSidecarForTest: vi.fn(),
  openComputerUsePermissions: vi.fn()
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
  openComputerUsePermissions: computerMocks.openComputerUsePermissions
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

    await expect(call('computer.permissions', {})).resolves.toBe(result)
    expect(computerMocks.openComputerUsePermissions).toHaveBeenCalledWith()
  })

  it('lists windows through the sidecar', async () => {
    const result = {
      app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
      windows: []
    }
    const params = { app: 'Finder', worktree: 'path:/tmp/repo' }
    computerMocks.callComputerSidecarListWindows.mockResolvedValue(result)

    await expect(call('computer.listWindows', params)).resolves.toBe(result)
    expect(computerMocks.callComputerSidecarListWindows).toHaveBeenCalledWith(params)
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

  it('rejects incomplete pointer action coordinates', () => {
    expect(() => findMethod('computer.click').params!.parse({ app: 'Finder' })).toThrow(
      /Click requires/
    )
    expect(() => findMethod('computer.click').params!.parse({ app: 'Finder', x: 1 })).toThrow(
      /both --x and --y/
    )
    expect(() =>
      findMethod('computer.click').params!.parse({ app: 'Finder', elementIndex: 0, x: 1, y: 2 })
    ).toThrow(/either --element-index or coordinate flags/)
    expect(() =>
      findMethod('computer.scroll').params!.parse({ app: 'Finder', direction: 'down' })
    ).toThrow(/Scroll requires/)
    expect(() =>
      findMethod('computer.scroll').params!.parse({
        app: 'Finder',
        elementIndex: 0,
        x: 1,
        y: 2,
        direction: 'down'
      })
    ).toThrow(/either --element-index or coordinate flags/)
    expect(() =>
      findMethod('computer.drag').params!.parse({ app: 'Finder', fromX: 1, fromY: 2 })
    ).toThrow(/Drag coordinates/)
    expect(() =>
      findMethod('computer.drag').params!.parse({ app: 'Finder', fromElementIndex: 1 })
    ).toThrow(/both --from-element-index and --to-element-index/)
    expect(() =>
      findMethod('computer.drag').params!.parse({
        app: 'Finder',
        fromElementIndex: 0,
        toElementIndex: 1,
        fromX: 1,
        fromY: 2,
        toX: 3,
        toY: 4
      })
    ).toThrow(/either element indexes or coordinate flags/)
  })

  it('rejects unsupported scroll directions', () => {
    expect(() =>
      findMethod('computer.scroll').params!.parse({
        app: 'Finder',
        elementIndex: 0,
        direction: 'diagonal'
      })
    ).toThrow()
    expect(() =>
      findMethod('computer.scroll').params!.parse({
        app: 'Finder',
        elementIndex: 0,
        direction: 'down',
        pages: 0
      })
    ).toThrow()
  })

  it('dispatches pointer and element actions through the sidecar', async () => {
    computerMocks.callComputerSidecarAction.mockResolvedValue({ ok: true })

    await call('computer.click', {
      app: 'Finder',
      worktree: 'path:/tmp/repo',
      elementIndex: 0,
      clickCount: 2,
      mouseButton: 'left',
      noScreenshot: true
    })
    await call('computer.performSecondaryAction', {
      app: 'Finder',
      elementIndex: 0,
      action: 'Raise'
    })
    await call('computer.drag', {
      app: 'Finder',
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4
    })

    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(1, 'click', {
      app: 'Finder',
      worktree: 'path:/tmp/repo',
      elementIndex: 0,
      clickCount: 2,
      mouseButton: 'left',
      noScreenshot: true
    })
    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(
      2,
      'performSecondaryAction',
      {
        app: 'Finder',
        elementIndex: 0,
        action: 'Raise'
      }
    )
    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(3, 'drag', {
      app: 'Finder',
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4
    })
  })

  it('dispatches keyboard and text actions through the sidecar', async () => {
    computerMocks.callComputerSidecarAction.mockResolvedValue({ ok: true })

    await call('computer.typeText', { app: 'Finder', text: 'hello', noScreenshot: true })
    await call('computer.pressKey', { app: 'Finder', key: 'Return' })
    await call('computer.hotkey', { app: 'Finder', key: 'CmdOrCtrl+L' })
    await call('computer.pasteText', { app: 'Finder', text: 'long text' })

    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(1, 'typeText', {
      app: 'Finder',
      text: 'hello',
      noScreenshot: true
    })
    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(2, 'pressKey', {
      app: 'Finder',
      key: 'Return'
    })
    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(3, 'hotkey', {
      app: 'Finder',
      key: 'CmdOrCtrl+L'
    })
    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(4, 'pasteText', {
      app: 'Finder',
      text: 'long text'
    })
  })

  it('dispatches scroll and setValue actions through the sidecar', async () => {
    computerMocks.callComputerSidecarAction.mockResolvedValue({ ok: true })

    await call('computer.scroll', {
      app: 'Finder',
      elementIndex: 0,
      direction: 'down',
      pages: 2
    })
    await call('computer.setValue', {
      app: 'Finder',
      elementIndex: 1,
      value: ''
    })

    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(1, 'scroll', {
      app: 'Finder',
      elementIndex: 0,
      direction: 'down',
      pages: 2
    })
    expect(computerMocks.callComputerSidecarAction).toHaveBeenNthCalledWith(2, 'setValue', {
      app: 'Finder',
      elementIndex: 1,
      value: ''
    })
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
