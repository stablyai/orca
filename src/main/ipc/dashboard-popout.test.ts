import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  ipcMainMock,
  appMock,
  createPopoutMock,
  closePopoutMock,
  getPopoutMock,
  isPopoutRendererMock,
  isTrustedUIRendererMock,
  getTrustedWindowMock,
  sendToTrustedMock,
  safelyRevealMock
} = vi.hoisted(() => {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers: map,
    ipcMainMock: {
      removeHandler: vi.fn(),
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => map.set(channel, fn)
    },
    appMock: { focus: vi.fn() },
    createPopoutMock: vi.fn(),
    closePopoutMock: vi.fn(),
    getPopoutMock: vi.fn((): unknown => null),
    isPopoutRendererMock: vi.fn((_sender: unknown) => false),
    isTrustedUIRendererMock: vi.fn((_sender: unknown) => false),
    getTrustedWindowMock: vi.fn((): unknown => null),
    sendToTrustedMock: vi.fn(),
    safelyRevealMock: vi.fn()
  }
})

vi.mock('electron', () => ({ app: appMock, ipcMain: ipcMainMock }))
vi.mock('../window/dashboard-popout-window', () => ({
  createOrFocusDashboardPopout: createPopoutMock,
  closeDashboardPopout: closePopoutMock,
  getDashboardPopoutWindow: getPopoutMock,
  isDashboardPopoutRenderer: isPopoutRendererMock,
  onDashboardPopoutOpenChanged: vi.fn()
}))
vi.mock('../window/focus-existing-window', () => ({ safelyRevealWindow: safelyRevealMock }))
vi.mock('./ui', () => ({
  getTrustedUIRendererWindow: getTrustedWindowMock,
  isTrustedUIRenderer: isTrustedUIRendererMock,
  sendToTrustedUIRenderer: sendToTrustedMock
}))

import { registerDashboardPopoutHandlers } from './dashboard-popout'

const mainSender = { id: 1, send: vi.fn() }
const popoutSender = { id: 2, send: vi.fn() }
const untrustedSender = { id: 3, send: vi.fn() }
const SNAPSHOT = { generatedAt: 1, cards: [] }

function makeWindow(sender: typeof mainSender) {
  return {
    isDestroyed: () => false,
    webContents: sender
  }
}

function makeStore(enabled = true) {
  let settingsListener:
    | ((updates: Record<string, unknown>, settings: Record<string, unknown>) => void)
    | null = null
  return {
    getSettings: vi.fn(() => ({ experimentalAgentDashboardPopout: enabled })),
    onSettingsChanged: vi.fn((listener) => {
      settingsListener = listener
      return vi.fn()
    }),
    fireSettingsChanged: (nextEnabled: boolean) =>
      settingsListener?.(
        { experimentalAgentDashboardPopout: nextEnabled },
        { experimentalAgentDashboardPopout: nextEnabled }
      )
  }
}

describe('registerDashboardPopoutHandlers', () => {
  let store: ReturnType<typeof makeStore>

  beforeEach(() => {
    handlers.clear()
    store = makeStore()
    isTrustedUIRendererMock.mockImplementation((sender) => sender === mainSender)
    isPopoutRendererMock.mockImplementation((sender) => sender === popoutSender)
    registerDashboardPopoutHandlers(store as never)
  })

  afterEach(() => {
    vi.clearAllMocks()
    getPopoutMock.mockReturnValue(null)
    getTrustedWindowMock.mockReturnValue(null)
  })

  it('opens only for the trusted main renderer while the feature is enabled', () => {
    handlers.get('dashboardPopout:open')!({ sender: untrustedSender } as never)
    expect(createPopoutMock).not.toHaveBeenCalled()

    store.getSettings.mockReturnValue({ experimentalAgentDashboardPopout: false })
    handlers.get('dashboardPopout:open')!({ sender: mainSender } as never)
    expect(createPopoutMock).not.toHaveBeenCalled()

    store.getSettings.mockReturnValue({ experimentalAgentDashboardPopout: true })
    handlers.get('dashboardPopout:open')!({ sender: mainSender } as never)
    expect(createPopoutMock).toHaveBeenCalledWith(store)
  })

  it('auto-closes the popout when the feature is disabled', () => {
    store.fireSettingsChanged(false)
    expect(closePopoutMock).toHaveBeenCalledOnce()
  })

  it('caches and forwards only valid trusted snapshots', () => {
    const popout = makeWindow(popoutSender)
    getPopoutMock.mockReturnValue(popout)

    handlers.get('dashboard:publishSnapshot')!({ sender: untrustedSender } as never, SNAPSHOT)
    handlers.get('dashboard:publishSnapshot')!({ sender: mainSender } as never, {
      generatedAt: Number.NaN,
      cards: []
    })
    expect(popoutSender.send).not.toHaveBeenCalled()

    handlers.get('dashboard:publishSnapshot')!({ sender: mainSender } as never, SNAPSHOT)
    expect(popoutSender.send).toHaveBeenCalledWith('dashboard:snapshot', SNAPSHOT)
  })

  it('replays the cached snapshot only to the popout and nudges only the trusted main renderer', () => {
    const popout = makeWindow(popoutSender)
    getPopoutMock.mockReturnValue(popout)
    handlers.get('dashboard:publishSnapshot')!({ sender: mainSender } as never, SNAPSHOT)

    handlers.get('dashboard:requestSnapshot')!({ sender: untrustedSender } as never)
    expect(untrustedSender.send).not.toHaveBeenCalled()

    handlers.get('dashboard:requestSnapshot')!({ sender: popoutSender } as never)
    expect(popoutSender.send).toHaveBeenCalledWith('dashboard:snapshot', SNAPSHOT)
    expect(sendToTrustedMock).toHaveBeenCalledWith('dashboard:snapshotRequested', null)
  })

  it('reports open state only to the trusted main renderer', () => {
    getPopoutMock.mockReturnValue(makeWindow(popoutSender))
    expect(handlers.get('dashboard:getPopoutOpen')!({ sender: untrustedSender } as never)).toBe(
      false
    )
    expect(handlers.get('dashboard:getPopoutOpen')!({ sender: mainSender } as never)).toBe(true)
  })

  it('relays valid seen acknowledgements from only the popout', () => {
    handlers.get('dashboardPopout:ackAgent')!({ sender: untrustedSender } as never, {
      paneKey: 'tab1:leaf1'
    })
    handlers.get('dashboardPopout:ackAgent')!({ sender: popoutSender } as never, { paneKey: '' })
    expect(sendToTrustedMock).not.toHaveBeenCalled()

    handlers.get('dashboardPopout:ackAgent')!({ sender: popoutSender } as never, {
      paneKey: 'tab1:leaf1'
    })
    expect(sendToTrustedMock).toHaveBeenCalledWith('ui:ackDashboardAgent', 'tab1:leaf1')
  })

  it('reveals an agent in only the trusted main window', () => {
    const main = makeWindow(mainSender)
    getTrustedWindowMock.mockReturnValue(main)
    const args = { repoId: 'r1', worktreeId: 'w1', tabId: 't1', leafId: 'l1' }

    handlers.get('dashboardPopout:revealAgent')!({ sender: untrustedSender } as never, args)
    handlers.get('dashboardPopout:revealAgent')!({ sender: popoutSender } as never, {
      ...args,
      tabId: ''
    })
    expect(safelyRevealMock).not.toHaveBeenCalled()

    handlers.get('dashboardPopout:revealAgent')!({ sender: popoutSender } as never, args)
    expect(safelyRevealMock).toHaveBeenCalledWith(main)
    expect(mainSender.send).toHaveBeenCalledWith('ui:revealDashboardAgent', args)
    expect(appMock.focus).toHaveBeenCalledOnce()
  })
})
