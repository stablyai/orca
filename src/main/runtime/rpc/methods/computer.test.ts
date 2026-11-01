import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods } from '../core'

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

  it('rejects ignored listApps scoping params', () => {
    expect(() =>
      findMethod('computer.listApps').params!.parse({ worktree: 'path:/tmp/repo' })
    ).toThrow()
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
})

function findMethod(name: string) {
  const method = eraseRpcMethods(COMPUTER_METHODS).find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`missing method ${name}`)
  }
  return method
}
