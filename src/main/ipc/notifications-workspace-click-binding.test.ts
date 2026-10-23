import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getDispatchHandler,
  getNotificationEventHandler,
  getTrustedUIRendererWindowMock,
  notificationOnMock,
  resetNotificationDispatchMocks
} from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { registerNotificationHandlers } from './notifications'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

beforeEach(() => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
  vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
})
afterEach(() => vi.unstubAllEnvs())

function registerWithMainWindow(): ReturnType<typeof vi.fn> {
  const webContentsSend = vi.fn()
  getTrustedUIRendererWindowMock.mockReturnValue({
    isDestroyed: () => false,
    isFocused: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: webContentsSend }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only getSettings().notifications, which this stub provides.
  registerNotificationHandlers({
    getSettings: () => ({
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: true
      }
    })
  } as never)
  return webContentsSend
}

function clickHandlerBound(): boolean {
  return notificationOnMock.mock.calls.some((call: unknown[]) => call[0] === 'click')
}

// A terminal pane in a workspace with no repo (floating or folder) is revealed by focusTerminal
// alone; its notification click used to be dropped because no repo id could be extracted.
describe('terminal notification clicks in repo-less workspaces', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetNotificationDispatchMocks()
  })

  it.each([
    ['floating', FLOATING_TERMINAL_WORKTREE_ID],
    ['folder', 'folder:fw-1']
  ])('focuses the %s workspace pane without activating a repo', async (_kind, worktreeId) => {
    const webContentsSend = registerWithMainWindow()

    await getDispatchHandler()({}, { source: 'agent-task-complete', worktreeId, paneKey: PANE_KEY })
    getNotificationEventHandler('click')()

    expect(webContentsSend).toHaveBeenCalledWith('ui:focusTerminal', {
      tabId: 'tab-1',
      worktreeId,
      leafId: LEAF_ID,
      ackPaneKeyOnSuccess: PANE_KEY,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    expect(webContentsSend).not.toHaveBeenCalledWith('ui:activateWorktree', expect.anything())
  })

  it('binds no click for a repo-less workspace without a pane to reveal', async () => {
    registerWithMainWindow()

    await getDispatchHandler()(
      {},
      { source: 'agent-task-complete', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
    )

    expect(clickHandlerBound()).toBe(false)
  })
})
