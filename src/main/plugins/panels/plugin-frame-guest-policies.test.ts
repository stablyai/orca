import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  popup: vi.fn(),
  buildFromTemplate: vi.fn(),
  forwarding: vi.fn(),
  template: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../../browser/browser-guest-shortcut-forwarding', () => ({
  setupGuestShortcutForwarding: mocks.forwarding
}))
vi.mock('../../window/editable-context-menu', () => ({
  buildEditableContextMenuTemplate: mocks.template
}))

const { installPluginFrameGuestPolicies } = await import('./plugin-frame-guest-policies')

function fake(value: unknown): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer uses only the members these fakes define.
  return value as Electron.WebContents
}

function fakeGuest() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    id: 9,
    handlers,
    on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
    once: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }
}

describe('plugin guest policies', () => {
  it("forwards Orca's shortcuts with plugin-frame scoping and offers the editable context menu", () => {
    mocks.buildFromTemplate.mockReturnValue({ popup: mocks.popup })
    mocks.template.mockReturnValue([{ role: 'copy' }])
    const guest = fakeGuest()
    const host = { isDestroyed: () => false }
    installPluginFrameGuestPolicies(fake(guest), '0123456789abcdef', fake(host), () => undefined)

    expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    expect(mocks.forwarding).toHaveBeenCalledWith(
      expect.objectContaining({ browserTabId: 'plugin-frame:9', browserPage: false })
    )
    const params = { isEditable: true }
    guest.handlers.get('context-menu')?.({}, params)
    expect(mocks.template).toHaveBeenCalledWith(params, guest, { plainText: true })
    expect(mocks.popup).toHaveBeenCalledWith({ window: { id: 1 } })
  })

  it('opens no menu outside editable fields', () => {
    mocks.popup.mockClear()
    mocks.template.mockReturnValue([])
    const guest = fakeGuest()
    installPluginFrameGuestPolicies(
      fake(guest),
      'k',
      fake({ isDestroyed: () => false }),
      () => undefined
    )
    guest.handlers.get('context-menu')?.({}, { isEditable: false })
    expect(mocks.popup).not.toHaveBeenCalled()
  })
})
