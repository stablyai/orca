import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDocPreviewGrant,
  mintDocPreviewGrant,
  revokeDocPreviewGrant
} from '../browser/doc-preview-grant-registry'
import { parseDocPreviewUrl } from '../../shared/doc-preview-scheme'
import {
  closeDocumentPreviewWindows,
  openHtmlPreviewWindow,
  openMarkdownPreviewWindow
} from './document-preview-window'

const mocks = vi.hoisted(() => ({
  windows: new Array<MockPreviewWindow>(),
  disposePolicy: vi.fn(),
  previewSession: {},
  failNextLoad: false
}))

class MockPreviewWindow extends EventEmitter {
  options: Electron.BrowserWindowConstructorOptions
  destroyed = false
  show = vi.fn()
  showInactive = vi.fn()
  restore = vi.fn()
  webContents = {
    session: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn()
    }
  }
  loadURL = vi.fn(async (_url: string) => {
    if (mocks.failNextLoad) {
      mocks.failNextLoad = false
      throw new Error('Host unavailable')
    }
    this.emit('ready-to-show')
  })
  setMenu = vi.fn()
  constructor(options: Electron.BrowserWindowConstructorOptions = {}) {
    super()
    this.options = options
    mocks.windows.push(this)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return true
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (options: Electron.BrowserWindowConstructorOptions) {
    return new MockPreviewWindow(options)
  }),
  Menu: { buildFromTemplate: vi.fn(() => ({})) }
}))
vi.mock('../browser/doc-preview-protocol', () => ({
  getDocPreviewSession: () => mocks.previewSession
}))
vi.mock('../browser/doc-preview-guest-policy', () => ({
  installDocPreviewGuestPolicy: () => mocks.disposePolicy
}))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))

afterEach(() => {
  closeDocumentPreviewWindows()
  mocks.windows = []
  mocks.failNextLoad = false
  vi.clearAllMocks()
})

describe('independent document preview windows', () => {
  it('renders Markdown without scripts or preload, reuses its window, and never reveals in background', async () => {
    const request = { fileId: 'md-1', title: 'Report', html: '<h1>报告</h1>' }
    await openMarkdownPreviewWindow(request)
    await openMarkdownPreviewWindow({ ...request, html: '<h1>Updated</h1>' })
    expect(mocks.windows).toHaveLength(1)
    const window = mocks.windows[0]!
    expect(window.options.show).toBe(false)
    expect(window.options.webPreferences).toMatchObject({
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    })
    expect(window.options.webPreferences?.preload).toBeUndefined()
    expect(window.loadURL).toHaveBeenCalledTimes(2)
    expect(window.loadURL.mock.calls[1]?.[0]).toContain(
      Buffer.from('<h1>Updated</h1>').toString('base64')
    )
    expect(window.show).not.toHaveBeenCalled()
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.restore).not.toHaveBeenCalled()
  })

  it.each(['ssh', 'runtime'] as const)(
    'keeps %s HTML authority after the source closes, and revokes only the copy on close',
    async (kind) => {
      const source = mintDocPreviewGrant({
        owner:
          kind === 'ssh'
            ? { kind: 'ssh', connectionId: 'remote-1' }
            : {
                kind: 'runtime',
                environmentId: 'env-1',
                worktreeSelector: 'folder:report',
                worktreeRoot: '/repo'
              },
        requestBase: '/repo',
        root: '/repo/reports',
        entryRelativePath: 'reports/index.html',
        browserPageId: 'html-1'
      })
      source.authorizedRoots.push('/repo/assets')
      const host = new BrowserWindow().webContents
      await openHtmlPreviewWindow(source.id, host)
      await openHtmlPreviewWindow(source.id, host)
      expect(mocks.windows).toHaveLength(2)
      const window = mocks.windows[1]!
      const target = parseDocPreviewUrl(window.loadURL.mock.calls[0]![0])!
      const clone = getDocPreviewGrant(target.grantId)!
      expect(clone.id).not.toBe(source.id)
      expect(clone.owner).toEqual(source.owner)
      expect(clone.authorizedRoots).toEqual(source.authorizedRoots)
      expect(clone.authorizedRoots).not.toBe(source.authorizedRoots)
      expect(window.options.webPreferences?.session).toBe(mocks.previewSession)
      expect(window.options.webPreferences?.preload).toBeUndefined()
      revokeDocPreviewGrant(source.id)
      expect(getDocPreviewGrant(clone.id)).toBe(clone)
      window.close()
      expect(getDocPreviewGrant(clone.id)).toBeNull()
      expect(mocks.disposePolicy).toHaveBeenCalledOnce()
      expect(window.show).not.toHaveBeenCalled()
    }
  )

  it('rejects a stale grant without creating a window', async () => {
    const host = new BrowserWindow().webContents
    await expect(openHtmlPreviewWindow('a'.repeat(32), host)).rejects.toThrow('no longer available')
    expect(mocks.windows).toHaveLength(1)
  })

  it('closes a failed load and permits opening another window', async () => {
    mocks.failNextLoad = true
    const request = { fileId: 'md-1', title: 'Report', html: '<p>Content</p>' }
    await expect(openMarkdownPreviewWindow(request)).rejects.toThrow('Host unavailable')
    expect(mocks.windows[0]?.destroyed).toBe(true)
    await openMarkdownPreviewWindow(request)
    expect(mocks.windows).toHaveLength(2)
  })
})
