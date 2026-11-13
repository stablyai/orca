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
const CARD = {
  paneKey: 'tab-1:leaf-1',
  ptyId: 'pty-1',
  agentType: 'codex',
  bucket: 'working',
  dotState: 'working',
  task: 'Ship it',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  repoName: 'Orca',
  worktreeName: 'Dashboard',
  startedAt: 1,
  finishedAt: null,
  stateChangedAt: 1,
  unseen: false
}

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

// These cases exercise foreground behavior against Electron mocks.
beforeEach(() => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
  vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('registerDashboardPopoutHandlers', () => {
  let store: ReturnType<typeof makeStore>

  beforeEach(() => {
    handlers.clear()
    store = makeStore()
    isTrustedUIRendererMock.mockImplementation((sender) => sender === mainSender)
    isPopoutRendererMock.mockImplementation((sender) => sender === popoutSender)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only reads getSettings and onSettingsChanged, both supplied by this mock.
    registerDashboardPopoutHandlers(store as never)
  })

  afterEach(() => {
    vi.clearAllMocks()
    getPopoutMock.mockReturnValue(null)
    getTrustedWindowMock.mockReturnValue(null)
  })

  // Invalid cards must not silently freeze the rest of the board.
  it.each([
    { conversationName: 'x'.repeat(1_025) },
    { chatSession: { sessionId: '', target: { kind: 'local' } } },
    { chatSession: { sessionId: 'chat', target: { kind: 'environment', environmentId: '' } } },
    { chatSession: { sessionId: 'chat', target: { kind: 'unknown' } } }
  ])('keeps publishing the board when one card is invalid (%j), and says so', (invalid) => {
    const popout = makeWindow(popoutSender)
    getPopoutMock.mockReturnValue(popout)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const good = {
      ...CARD,
      paneKey: 'tab-1:leaf-1',
      chatSession: { sessionId: 'chat', target: { kind: 'local' } }
    }
    const bad = { ...CARD, paneKey: 'tab-2:leaf-2', ...invalid }

    handlers.get('dashboard:publishSnapshot')!(
      { sender: mainSender },
      {
        generatedAt: 2,
        cards: [good, bad]
      }
    )

    expect(popoutSender.send).toHaveBeenCalledWith('dashboard:snapshot', {
      generatedAt: 2,
      cards: [good]
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 invalid card'))
    warn.mockRestore()
  })
})
