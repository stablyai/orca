import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { Store } from '../persistence'
import type * as IpcUiModule from '../ipc/ui'

const {
  handleMock,
  removeHandlerMock,
  isTrustedUIRendererMock,
  getLinuxPackageInstallInstructionsMock,
  showLinuxPackageMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  isTrustedUIRendererMock: vi.fn<(sender: unknown) => boolean>(() => true),
  getLinuxPackageInstallInstructionsMock: vi.fn(),
  showLinuxPackageMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.51') },
  clipboard: {},
  systemPreferences: { askForMediaAccess: vi.fn(), getMediaAccessStatus: vi.fn() },
  ipcMain: {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))

vi.mock('../ipc/repos', () => ({ registerRepoHandlers: vi.fn() }))
vi.mock('../ipc/worktrees', () => ({ registerWorktreeHandlers: vi.fn() }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('../ipc/pty', () => ({ getLocalPtyProvider: vi.fn(), registerPtyHandlers: vi.fn() }))
vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: vi.fn()
}))
vi.mock('../browser/browser-manager', () => ({ browserManager: { unregisterAll: vi.fn() } }))
vi.mock('../macos-tcc-prompt-notice', () => ({
  acknowledgePendingTccPromptNotice: vi.fn(),
  consumePendingTccPromptNotice: vi.fn(),
  dismissTccPromptNotice: vi.fn(),
  releasePendingTccPromptNotice: vi.fn()
}))

vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  checkForUpdatesFromMenu: vi.fn(),
  downloadUpdate: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  dismissAvailableUpdate: vi.fn(),
  setupAutoUpdater: vi.fn(),
  getLinuxPackageInstallInstructions: getLinuxPackageInstallInstructionsMock,
  showLinuxPackage: showLinuxPackageMock
}))

// Why: the seam stays mocked so one test can prove the wiring, but it defaults to delegating to the
// real predicate so the sender cases below exercise its actual branches.
vi.mock('../ipc/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof IpcUiModule>()),
  isTrustedUIRenderer: (sender: unknown) => isTrustedUIRendererMock(sender)
}))

import { registerUpdaterHandlers } from './attach-main-window-services'

const RECOVERY_CHANNELS = [
  'updater:getLinuxPackageInstallInstructions',
  'updater:showLinuxPackage'
] as const

const TRUSTED_ID = 7
const UNAUTHORIZED = 'Unauthorized updater package recovery sender'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

let actualUi: typeof IpcUiModule

function getHandler(channel: string): InvokeHandler {
  const handler = handleMock.mock.calls.find(([name]) => name === channel)?.[1] as
    | InvokeHandler
    | undefined
  if (!handler) {
    throw new Error(`no handler registered for ${channel}`)
  }
  return handler
}

function webContents(overrides: Partial<WebContents>): Partial<WebContents> {
  return {
    id: TRUSTED_ID,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///index.html',
    ...overrides
  }
}

function senderEvent(sender: Partial<WebContents>): IpcMainInvokeEvent {
  return { sender } as IpcMainInvokeEvent
}

function expectBothChannelsRejected(sender: Partial<WebContents>): void {
  const event = senderEvent(sender)
  for (const channel of RECOVERY_CHANNELS) {
    expect(() => getHandler(channel)(event)).toThrow(UNAUTHORIZED)
  }
  expect(getLinuxPackageInstallInstructionsMock).not.toHaveBeenCalled()
  expect(showLinuxPackageMock).not.toHaveBeenCalled()
}

describe('updater linux package recovery IPC handlers', () => {
  beforeAll(async () => {
    // An unmocked copy, so the trusted-id state it reads is the one these tests set.
    actualUi = await vi.importActual<typeof IpcUiModule>('../ipc/ui')
  })

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    isTrustedUIRendererMock
      .mockReset()
      .mockImplementation((sender) => actualUi.isTrustedUIRenderer(sender as WebContents))
    actualUi.setTrustedUIRendererWebContentsId(TRUSTED_ID)
    getLinuxPackageInstallInstructionsMock
      .mockReset()
      .mockResolvedValue({ ok: true, command: "sudo apt install -- '<pkg>'", packageFileName: 'p' })
    showLinuxPackageMock.mockReset().mockResolvedValue(undefined)
    registerUpdaterHandlers({} as Store)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('removes and re-registers both recovery channels', () => {
    for (const channel of RECOVERY_CHANNELS) {
      expect(removeHandlerMock).toHaveBeenCalledWith(channel)
      expect(handleMock.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
    }
  })

  it('routes both channels through the trusted-renderer guard', () => {
    isTrustedUIRendererMock.mockReturnValue(false)

    expectBothChannelsRejected(webContents({}))

    expect(isTrustedUIRendererMock).toHaveBeenCalledTimes(2)
  })

  it('serves the current main UI renderer', async () => {
    const event = senderEvent(webContents({}))

    await expect(getHandler(RECOVERY_CHANNELS[0])(event)).resolves.toEqual({
      ok: true,
      command: "sudo apt install -- '<pkg>'",
      packageFileName: 'p'
    })
    await expect(getHandler(RECOVERY_CHANNELS[1])(event)).resolves.toBeUndefined()
  })

  // Each row is a distinct branch of the real isTrustedUIRenderer, not a relabelled mock return.
  it.each([
    ['a guest webview', webContents({ getType: () => 'webview' })],
    ['a utility renderer', webContents({ getType: () => 'offscreen' })],
    ['a destroyed sender', webContents({ isDestroyed: () => true })],
    ['a dashboard popout or stale window', webContents({ id: TRUSTED_ID + 1 })]
  ])('rejects both recovery channels for %s', (_label, sender) => {
    expectBothChannelsRejected(sender)
  })

  it('rejects a foreign-origin renderer when only the dev URL fallback applies', () => {
    actualUi.setTrustedUIRendererWebContentsId(null)
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

    expectBothChannelsRejected(webContents({ getURL: () => 'http://evil.invalid/index.html' }))
  })

  it('rechecks sender trust on every invocation', () => {
    const event = senderEvent(webContents({}))
    void getHandler(RECOVERY_CHANNELS[0])(event)

    // The main window was replaced between calls; the previously served sender is now stale.
    actualUi.setTrustedUIRendererWebContentsId(TRUSTED_ID + 1)

    expect(() => getHandler(RECOVERY_CHANNELS[0])(event)).toThrow(UNAUTHORIZED)
    expect(getLinuxPackageInstallInstructionsMock).toHaveBeenCalledTimes(1)
  })
})
