import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DestroyedGuestTestContents } from '../registration/browser-manager-destroyed-guest-test-fixture'

const mocks = vi.hoisted(() => ({
  webContentsById: new Map<number, unknown>(),
  windowByWebContents: new Map<unknown, unknown>(),
  openPopupWithOriginBar: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: {
    fromWebContents: (contents: unknown) => mocks.windowByWebContents.get(contents) ?? null
  },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
  shell: { openExternal: vi.fn() },
  webContents: {
    fromId: (id: number) => mocks.webContentsById.get(id)
  }
}))

vi.mock('../../popups/presentation/popup-origin-bar-window', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openPopupWithOriginBar: mocks.openPopupWithOriginBar
}))

import { withAgentInputInjection } from '../../../cdp/input/agent-input-injection'
import { browserManager } from '../browser-manager'
import { rendererWebContentsId, resetBrowserManagerState } from '../browser-manager-test-harness'
import { runWithActiveRpcCaller } from '../../../../runtime/rpc/callers/active-call'
import type { RpcCallerIdentity } from '../../../../runtime/rpc/callers/rpc-caller-identity'

type WindowOpenResponse = {
  action: 'allow' | 'deny'
  createWindow?: (options: { webContents: unknown }) => unknown
}

class PopupTestGuest extends DestroyedGuestTestContents {
  windowOpenHandler: ((details: Record<string, unknown>) => WindowOpenResponse) | null = null
  override setWindowOpenHandler(
    handler?: (details: Record<string, unknown>) => WindowOpenResponse
  ): void {
    this.windowOpenHandler = handler ?? null
  }
  setIgnoreMenuShortcuts(): void {}
}

function createDesktopGuest({ visible }: { visible: boolean }) {
  const rendererSend = vi.fn()
  const renderer = Object.assign(new EventEmitter(), {
    id: rendererWebContentsId,
    isDestroyed: () => false,
    send: rendererSend
  })
  const desktopWindow = {
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => false
  }
  const guest = new PopupTestGuest(201)
  mocks.webContentsById.set(renderer.id, renderer)
  mocks.webContentsById.set(guest.id, guest)
  mocks.windowByWebContents.set(renderer, desktopWindow)
  browserManager.attachGuestPolicies(guest.asWebContents())
  expect(
    browserManager.registerGuest({
      browserPageId: 'page-1',
      webContentsId: guest.id,
      rendererWebContentsId: renderer.id,
      worktreeId: 'wt-1'
    })
  ).toBe(true)
  return { guest, rendererSend }
}

function createChildContents(opener: unknown) {
  return Object.assign(new EventEmitter(), {
    id: 301,
    opener,
    session: null,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
    close: vi.fn()
  })
}

async function clickViaCommand(
  guest: PopupTestGuest,
  caller: RpcCallerIdentity
): Promise<WindowOpenResponse> {
  return runWithActiveRpcCaller(caller, async () => {
    const lease = browserManager.beginAgentCommand('page-1')
    try {
      return await browserManager.runPageCommand('page-1', caller, () =>
        lease.run(async () => {
          await withAgentInputInjection(guest.asWebContents(), async () => {
            guest.emit('before-mouse-event', {}, { type: 'mouseUp' })
          })
          return guest.windowOpenHandler!({
            url: 'https://picker.example/select',
            frameName: '',
            features: '',
            disposition: 'foreground-tab',
            referrer: { url: 'https://example.test', policy: 'default' }
          })
        })
      )
    } finally {
      lease.end()
    }
  })
}

describe('popup opener routing for injected input', () => {
  afterEach(() => {
    resetBrowserManagerState()
    mocks.webContentsById.clear()
    mocks.windowByWebContents.clear()
    mocks.openPopupWithOriginBar.mockReset()
  })

  it('keeps window.opener for a local CLI click on a visible desktop window and still converts opener-less links to tabs', async () => {
    const { guest, rendererSend } = createDesktopGuest({ visible: true })
    mocks.openPopupWithOriginBar.mockImplementation((options: { webContents: unknown }) => ({
      contentWebContents: options.webContents,
      close: vi.fn(),
      onClosed: vi.fn()
    }))

    const popupResponse = await clickViaCommand(guest, { kind: 'local-cli' })
    expect(popupResponse.action).toBe('allow')
    expect(rendererSend).not.toHaveBeenCalledWith(
      'browser:open-link-in-orca-tab',
      expect.anything()
    )

    const childWithOpener = createChildContents({ frame: 'opener' })
    popupResponse.createWindow?.({ webContents: childWithOpener })
    expect(mocks.openPopupWithOriginBar).toHaveBeenCalledTimes(1)
    expect(mocks.openPopupWithOriginBar).toHaveBeenCalledWith(
      expect.objectContaining({ showWhenAppActive: true }),
      'https://picker.example/select',
      expect.any(Function)
    )

    mocks.openPopupWithOriginBar.mockClear()
    const linkResponse = await clickViaCommand(guest, { kind: 'local-cli' })
    expect(linkResponse.action).toBe('allow')
    const childWithoutOpener = createChildContents(null)
    linkResponse.createWindow?.({ webContents: childWithoutOpener })
    expect(mocks.openPopupWithOriginBar).not.toHaveBeenCalled()
    expect(rendererSend).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'page-1',
      url: 'https://picker.example/select',
      activate: false
    })
  })

  it('keeps the up-front tab path for a local CLI click when the desktop window is hidden or on a headless server page', async () => {
    const { guest, rendererSend } = createDesktopGuest({ visible: false })
    const hiddenResponse = await clickViaCommand(guest, { kind: 'local-cli' })
    expect(hiddenResponse).toEqual({ action: 'deny' })
    expect(rendererSend).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'page-1',
      url: 'https://picker.example/select',
      activate: false
    })

    resetBrowserManagerState()
    mocks.webContentsById.clear()
    mocks.windowByWebContents.clear()
    const offscreenOpened = vi.fn()
    browserManager.setOffscreenTabOpener(offscreenOpened)
    const serverGuest = new PopupTestGuest(202)
    mocks.webContentsById.set(serverGuest.id, serverGuest)
    expect(
      browserManager.registerOffscreenGuest({
        browserPageId: 'page-1',
        worktreeId: 'wt-1',
        webContentsId: serverGuest.id
      })
    ).toBe(true)

    const serverResponse = await clickViaCommand(serverGuest, { kind: 'local-cli' })
    expect(serverResponse).toEqual({ action: 'deny' })
    expect(offscreenOpened).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      profileId: null,
      url: 'https://picker.example/select',
      activate: true,
      pairedDeviceId: null
    })
  })

  it('keeps the up-front tab path for paired phone and remote CLI callers even when the desktop window is visible', async () => {
    const { guest, rendererSend } = createDesktopGuest({ visible: true })

    const phoneResponse = await clickViaCommand(guest, {
      kind: 'paired-device',
      deviceId: 'phone-1'
    })
    expect(phoneResponse).toEqual({ action: 'deny' })
    expect(rendererSend).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'page-1',
      url: 'https://picker.example/select'
    })

    rendererSend.mockClear()
    const remoteCliResponse = await clickViaCommand(guest, {
      kind: 'paired-device',
      deviceId: 'laptop-1',
      agent: true
    })
    expect(remoteCliResponse).toEqual({ action: 'deny' })
    expect(rendererSend).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'page-1',
      url: 'https://picker.example/select',
      activate: false
    })
  })
})
