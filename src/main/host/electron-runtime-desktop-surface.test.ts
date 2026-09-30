import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getNotificationEventHandler,
  getTrustedUIRendererWindowMock,
  notificationOnMock,
  notificationRemoveListenerMock,
  notificationShowMock,
  resetNotificationDispatchMocks
} from '../ipc/notifications-test-harness'

vi.mock('electron', async () =>
  (await import('../ipc/notifications-test-harness')).createElectronModuleMock()
)

vi.mock('../ipc/ui', async () =>
  (await import('../ipc/notifications-test-harness')).createTrustedUIRendererModuleMock()
)

import { electronRuntimeDesktopSurface } from './electron-runtime-desktop-surface'

beforeEach(() => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
  vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
  resetNotificationDispatchMocks()
})
afterEach(() => vi.unstubAllEnvs())

describe('electronRuntimeDesktopSurface.showNotification', () => {
  it('reveals the target worktree and pane when a plugin notification is clicked', () => {
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
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

    expect(
      electronRuntimeDesktopSurface.showNotification({
        title: 'u1.lead: Done',
        body: 'Finished',
        target: { worktreeId: 'repo::wt1', paneKey }
      })
    ).toBe(true)
    expect(notificationShowMock).toHaveBeenCalledTimes(1)

    getNotificationEventHandler('click')()

    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('click', expect.any(Function))
    expect(webContentsSend).toHaveBeenCalledWith('ui:activateWorktree', {
      repoId: 'repo',
      worktreeId: 'repo::wt1'
    })
    expect(webContentsSend).toHaveBeenCalledWith('ui:focusTerminal', {
      tabId: 'tab-1',
      worktreeId: 'repo::wt1',
      leafId: '11111111-1111-4111-8111-111111111111',
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('shows a notification without a click action when no target is given', () => {
    expect(electronRuntimeDesktopSurface.showNotification({ title: 't', body: 'b' })).toBe(true)
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
    expect(notificationOnMock).not.toHaveBeenCalledWith('click', expect.anything())
  })
})
