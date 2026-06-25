import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('computer action RPC methods', () => {
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

  it('rejects modifier chords on press-key but allows literal plus', () => {
    expect(() =>
      findMethod('computer.pressKey').params!.parse({
        app: 'Finder',
        key: 'CmdOrCtrl+V'
      })
    ).toThrow(/Press-key accepts one key only/)

    expect(
      findMethod('computer.pressKey').params!.parse({
        app: 'Finder',
        key: '+'
      })
    ).toMatchObject({ key: '+' })
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

  it('leaves oversized computer paste text to async sidecar validation', async () => {
    const secret = 'computer-paste-secret'
    const text = secret + 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)

    expect(
      findMethod('computer.pasteText').params!.safeParse({
        app: 'Finder',
        text
      }).success
    ).toBe(true)
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
