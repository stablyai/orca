import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetachedTerminalTabSeed, Worktree } from '../../shared/types'

const { ipcHandle, isTrustedUIRenderer, getTrustedUIRendererWindow, mainWindowMock, managerMock } =
  vi.hoisted(() => ({
    ipcHandle: vi.fn(),
    isTrustedUIRenderer: vi.fn(() => true),
    getTrustedUIRendererWindow: vi.fn(),
    mainWindowMock: { webContents: { send: vi.fn() } },
    managerMock: {
      detachPane: vi.fn(),
      reintegratePane: vi.fn(),
      getPaneState: vi.fn(() => null),
      getPaneSeed: vi.fn((): DetachedTerminalTabSeed | null => null),
      isPaneWindowSender: vi.fn(() => false),
      onPaneParked: vi.fn((_listener: (paneId: string) => void) => vi.fn())
    }
  }))

vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle, removeHandler: vi.fn() } }))
vi.mock('./ui', () => ({ isTrustedUIRenderer, getTrustedUIRendererWindow }))
vi.mock('../window/detachable-pane-window-manager', () => ({
  detachablePaneWindowManager: managerMock
}))

import { registerDetachablePaneHandlers } from './detachable-pane'
import type { Store } from '../persistence'

function getHandler(channel: string): (event: unknown, args: unknown) => unknown {
  const call = ipcHandle.mock.calls.findLast(([registeredChannel]) => registeredChannel === channel)
  if (!call) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return call[1]
}

const trustedEvent = { sender: { id: 1 } }
const validSeed: DetachedTerminalTabSeed = {
  tab: { id: 'tab-1' } as unknown as DetachedTerminalTabSeed['tab'],
  layout: { root: null, activeLeafId: null, expandedLeafId: null },
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  repo: { id: 'wt-1', path: '/repo', displayName: 'Repo', badgeColor: '#000', addedAt: 0 },
  worktree: { id: 'wt-1', repoId: 'wt-1', displayName: 'Repo' } as unknown as Worktree
}

describe('registerDetachablePaneHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTrustedUIRenderer.mockReturnValue(true)
    getTrustedUIRendererWindow.mockReturnValue(mainWindowMock)
    managerMock.onPaneParked.mockReturnValue(vi.fn())
  })

  it('registers detach and getDetachedTabSeed handlers', () => {
    registerDetachablePaneHandlers({} as Store)
    expect(ipcHandle).toHaveBeenCalledWith('pane:detach', expect.any(Function))
    expect(ipcHandle).toHaveBeenCalledWith('pane:getDetachedTabSeed', expect.any(Function))
  })

  it('detach: passes paneId, store, and seed to the manager', () => {
    const store = {} as Store
    registerDetachablePaneHandlers(store)
    const handler = getHandler('pane:detach')
    handler(trustedEvent, { paneId: 'pane-1', seed: validSeed })
    expect(managerMock.detachPane).toHaveBeenCalledWith('pane-1', store, validSeed)
  })

  it('detach: throws on a malformed seed payload without detaching', () => {
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:detach')
    expect(() => handler(trustedEvent, { paneId: 'pane-1', seed: { tab: {} } })).toThrow()
    expect(managerMock.detachPane).not.toHaveBeenCalled()
  })

  it('detach: throws on a missing seed without detaching', () => {
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:detach')
    expect(() => handler(trustedEvent, { paneId: 'pane-1' })).toThrow()
    expect(managerMock.detachPane).not.toHaveBeenCalled()
  })

  it('detach: no-ops for an untrusted sender', () => {
    isTrustedUIRenderer.mockReturnValueOnce(false)
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:detach')
    handler({ sender: { id: 2 } }, { paneId: 'pane-1', seed: validSeed })
    expect(managerMock.detachPane).not.toHaveBeenCalled()
  })

  it('returns the stored seed from the manager', () => {
    managerMock.getPaneSeed.mockReturnValueOnce(validSeed)
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:getDetachedTabSeed')
    expect(handler(trustedEvent, { paneId: 'pane-1' })).toBe(validSeed)
  })

  it('returns null for getDetachedTabSeed from an untrusted sender', () => {
    isTrustedUIRenderer.mockReturnValueOnce(false)
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:getDetachedTabSeed')
    expect(handler({ sender: { id: 2 } }, { paneId: 'pane-1' })).toBeNull()
  })

  it('reintegrate: reads the seed before clearing it, calls reintegratePane, and broadcasts pane:returned to the main window', () => {
    managerMock.getPaneSeed.mockReturnValueOnce(validSeed)
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:reintegrate')
    handler(trustedEvent, { paneId: 'pane-1' })

    expect(managerMock.getPaneSeed).toHaveBeenCalledWith('pane-1')
    expect(managerMock.reintegratePane).toHaveBeenCalledWith('pane-1')
    expect(mainWindowMock.webContents.send).toHaveBeenCalledWith('pane:returned', {
      paneId: 'pane-1',
      seed: validSeed
    })
  })

  it('reintegrate: no-ops for an untrusted sender that does not own the pane window', () => {
    isTrustedUIRenderer.mockReturnValueOnce(false)
    managerMock.isPaneWindowSender.mockReturnValueOnce(false)
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:reintegrate')
    handler({ sender: { id: 2 } }, { paneId: 'pane-1' })

    expect(managerMock.reintegratePane).not.toHaveBeenCalled()
    expect(mainWindowMock.webContents.send).not.toHaveBeenCalled()
  })

  it("reintegrate: allows a pane's own popout window even when it is not the trusted UI renderer", () => {
    isTrustedUIRenderer.mockReturnValueOnce(false)
    managerMock.isPaneWindowSender.mockReturnValueOnce(true)
    managerMock.getPaneSeed.mockReturnValueOnce(validSeed)
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:reintegrate')
    handler({ sender: { id: 2 } }, { paneId: 'pane-1' })

    expect(managerMock.isPaneWindowSender).toHaveBeenCalledWith('pane-1', { id: 2 })
    expect(managerMock.reintegratePane).toHaveBeenCalledWith('pane-1')
  })

  it("getDetachedTabSeed: allows a pane's own popout window even when it is not the trusted UI renderer", () => {
    isTrustedUIRenderer.mockReturnValueOnce(false)
    managerMock.isPaneWindowSender.mockReturnValueOnce(true)
    managerMock.getPaneSeed.mockReturnValueOnce(validSeed)
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:getDetachedTabSeed')
    expect(handler({ sender: { id: 2 } }, { paneId: 'pane-1' })).toBe(validSeed)
    expect(managerMock.isPaneWindowSender).toHaveBeenCalledWith('pane-1', { id: 2 })
  })

  it('native close (parked): subscribes onPaneParked and runs the same finalizeReintegration broadcast', () => {
    registerDetachablePaneHandlers({} as Store)
    expect(managerMock.onPaneParked).toHaveBeenCalledWith(expect.any(Function))

    managerMock.getPaneSeed.mockReturnValueOnce(validSeed)
    const parkedListener = managerMock.onPaneParked.mock.calls[0][0] as (paneId: string) => void
    parkedListener('pane-1')

    expect(managerMock.reintegratePane).toHaveBeenCalledWith('pane-1')
    expect(mainWindowMock.webContents.send).toHaveBeenCalledWith('pane:returned', {
      paneId: 'pane-1',
      seed: validSeed
    })
  })

  it('re-registering unsubscribes the previous onPaneParked listener', () => {
    const unsubscribe = vi.fn()
    managerMock.onPaneParked.mockReturnValueOnce(unsubscribe)
    registerDetachablePaneHandlers({} as Store)
    registerDetachablePaneHandlers({} as Store)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
