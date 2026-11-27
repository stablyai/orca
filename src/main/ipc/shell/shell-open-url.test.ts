import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const openExternal = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }
  },
  shell: {
    openExternal
  }
}))
vi.mock('../../i18n/main-i18n', () => ({
  translateMain: (_k: string, fallback: string) => fallback
}))
vi.mock('../dialogs/single-flight-open-dialog', () => ({ showSingleFlightOpenDialog: vi.fn() }))
vi.mock('../../external-editors/external-editor-launch', () => ({
  launchExternalEditor: vi.fn(),
  resolveExternalEditorLaunchSpec: vi.fn()
}))
vi.mock('../../external-editors/remote-ssh-editor-launch', () => ({
  resolveRemoteSshEditorLaunchSpec: vi.fn()
}))
vi.mock('../../external-editors/open-in-editor-command', () => ({
  resolveOpenInEditorCommand: vi.fn()
}))
vi.mock('../../external-editors/default-app-location-open', () => ({
  openPathInDefaultApp: vi.fn()
}))
vi.mock('./forwarded-url-open-handler', () => ({
  registerForwardedUrlOpenHandler: vi.fn()
}))
vi.mock('./shell-editor-ssh-host', () => ({
  isEditorSshHostForOwner: vi.fn(),
  listAppRuntimeEnvironments: vi.fn()
}))
vi.mock('./shell-owned-path-target', () => ({
  isLocallyOwned: vi.fn(),
  localFileUriPath: vi.fn(),
  resolveOwnedPathTarget: vi.fn(),
  validateLocalPathTarget: vi.fn()
}))
vi.mock('./linked-file-inspection', () => ({ inspectLinkedFile: vi.fn() }))
vi.mock('./shell-path-existence-handlers', () => ({
  registerShellPathExistenceHandlers: vi.fn()
}))

import { registerShellHandlers } from './shell'

describe('shell:openUrl IPC handler', () => {
  beforeEach(() => {
    handlers.clear()
    openExternal.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal store stub unused by shell:openUrl
    registerShellHandlers({} as never)
  })

  it('opens valid http(s) URLs in the foreground by default', async () => {
    const handler = handlers.get('shell:openUrl')
    expect(handler).toBeDefined()

    await handler?.({}, 'https://example.com/docs?q=1')

    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs?q=1')
  })

  it('opens valid http(s) URLs without activating the browser when background is true', async () => {
    const handler = handlers.get('shell:openUrl')
    expect(handler).toBeDefined()

    await handler?.({}, 'https://example.com/docs', { background: true })

    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs', { activate: false })
  })

  it('falls back to foreground open when options is false or malformed', async () => {
    const handler = handlers.get('shell:openUrl')

    await handler?.({}, 'http://example.com', { background: false })
    await handler?.({}, 'http://example.com', null)
    await handler?.({}, 'http://example.com', 'background')

    expect(openExternal).toHaveBeenNthCalledWith(1, 'http://example.com/')
    expect(openExternal).toHaveBeenNthCalledWith(2, 'http://example.com/')
    expect(openExternal).toHaveBeenNthCalledWith(3, 'http://example.com/')
  })

  it('ignores non-http(s) schemes and invalid URLs even when background is true', async () => {
    const handler = handlers.get('shell:openUrl')

    await handler?.({}, 'file:///etc/passwd', { background: true })
    await handler?.({}, 'javascript:alert(1)', { background: true })
    await handler?.({}, 'not a url', { background: true })

    expect(openExternal).not.toHaveBeenCalled()
  })
})
