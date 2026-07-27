import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetachedTerminalTabSeed } from '../../shared/types'

const { ipcHandle, isTrustedUIRenderer, getTrustedUIRendererWindow, mainWindowMock, managerMock } =
  vi.hoisted(() => ({
    ipcHandle: vi.fn(),
    isTrustedUIRenderer: vi.fn(() => true),
    getTrustedUIRendererWindow: vi.fn(),
    mainWindowMock: { webContents: { send: vi.fn() } },
    managerMock: {
      detachPane: vi.fn(() => ({ webContents: { send: vi.fn() } })),
      reintegratePane: vi.fn(),
      removeTab: vi.fn(
        (): { seed: DetachedTerminalTabSeed | null; removedPtyId: string | null } => ({
          seed: null,
          removedPtyId: null
        })
      ),
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
vi.mock('./pty', () => ({
  registerDetachedPanePtys: vi.fn(),
  unregisterDetachedPanePtys: vi.fn()
}))

import { registerDetachablePaneHandlers } from './detachable-pane'
import { unregisterDetachedPanePtys } from './pty'
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
  repo: {
    id: 'wt-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0,
    connectionId: null,
    executionHostId: null
  }
}
const validGroupedSeed = {
  ...validSeed,
  additionalTabs: [
    {
      ...validSeed,
      tab: { id: 'tab-2' } as unknown as DetachedTerminalTabSeed['tab']
    }
  ]
} as DetachedTerminalTabSeed

const malformedAdditionalTabs = [
  ['tab', { ...validSeed, tab: undefined }],
  ['layout', { ...validSeed, layout: undefined }],
  ['ptyId', { ...validSeed, ptyId: 42 }],
  ['worktreeId', { ...validSeed, worktreeId: 42 }],
  ['groupId', { ...validSeed, groupId: 42 }],
  ['repo', { ...validSeed, repo: { ...validSeed.repo, id: 42 } }],
  ['nested additionalTabs', { ...validSeed, additionalTabs: [] }]
] as const

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

  it('detach: accepts a valid grouped seed with additional tabs', () => {
    const store = {} as Store
    registerDetachablePaneHandlers(store)
    const handler = getHandler('pane:detach')
    handler(trustedEvent, { paneId: 'pane-1', seed: validGroupedSeed })

    expect(managerMock.detachPane).toHaveBeenCalledWith('pane-1', store, validGroupedSeed)
  })

  it.each(malformedAdditionalTabs)(
    'detach: rejects an additional tab with an invalid %s',
    (_field, malformedAdditionalTab) => {
      registerDetachablePaneHandlers({} as Store)
      const handler = getHandler('pane:detach')
      const seed = {
        ...validSeed,
        additionalTabs: [malformedAdditionalTab]
      } as unknown as DetachedTerminalTabSeed

      expect(() => handler(trustedEvent, { paneId: 'pane-1', seed })).toThrow()
      expect(managerMock.detachPane).not.toHaveBeenCalled()
    }
  )

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

  // ── pane:removeTab ────────────────────────────────────────────────

  it('registers the pane:removeTab handler', () => {
    registerDetachablePaneHandlers({} as Store)
    expect(ipcHandle).toHaveBeenCalledWith('pane:removeTab', expect.any(Function))
  })

  it('removeTab: calls manager.removeTab with paneId and tabId', () => {
    managerMock.removeTab = vi.fn(() => ({ seed: null, removedPtyId: null }))
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:removeTab')
    handler(trustedEvent, { paneId: 'pane-1', tabId: 'tab-2' })

    expect(managerMock.removeTab).toHaveBeenCalledWith('pane-1', 'tab-2')
  })

  it('removeTab: calls unregisterDetachedPanePtys when a PTY is removed', () => {
    managerMock.removeTab = vi.fn(() => ({ seed: validSeed, removedPtyId: 'pty-3' }))
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:removeTab')
    handler(trustedEvent, { paneId: 'pane-1', tabId: 'tab-99' })

    expect(unregisterDetachedPanePtys).toHaveBeenCalledWith(['pty-3'])
  })

  it('removeTab: no-ops for an untrusted sender that does not own the pane', () => {
    isTrustedUIRenderer.mockReturnValueOnce(false)
    managerMock.isPaneWindowSender.mockReturnValueOnce(false)
    managerMock.removeTab = vi.fn()
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:removeTab')
    handler({ sender: { id: 2 } }, { paneId: 'pane-1', tabId: 'tab-1' })

    expect(managerMock.removeTab).not.toHaveBeenCalled()
  })

  it('removeTab: allows a pane window sender even when not trusted UI renderer', () => {
    isTrustedUIRenderer.mockReturnValueOnce(false)
    managerMock.isPaneWindowSender.mockReturnValueOnce(true)
    managerMock.removeTab = vi.fn(() => ({ seed: null, removedPtyId: null }))
    registerDetachablePaneHandlers({} as Store)
    const handler = getHandler('pane:removeTab')
    handler({ sender: { id: 2 } }, { paneId: 'pane-1', tabId: 'tab-1' })

    expect(managerMock.removeTab).toHaveBeenCalledWith('pane-1', 'tab-1')
  })
})
