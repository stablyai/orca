import { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CatalogModule from '../external-browsers/installed-browser-catalog'
import type { DetectedBrowser } from '../external-browsers/installed-browser-catalog'
import type * as RichMarkdownLinkMenuModule from './rich-markdown-link-context-menu'
import { richMarkdownContextMenuLinkTargetChannel } from '../../shared/rich-markdown-context-menu'

const ipcListeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
const openExternalUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('electron', () => ({
  // The module reads only mainWindow.webContents for sender checks.
  BrowserWindow: class {
    webContents = {}
  },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcListeners.set(channel, listener),
    removeListener: (channel: string) => ipcListeners.delete(channel)
  }
}))
const readBrowsers = vi.hoisted(() => vi.fn<() => Promise<DetectedBrowser[]>>())
vi.mock('../external-browsers/mac-installed-browsers', () => ({
  readMacInstalledBrowsers: readBrowsers
}))
vi.mock('../external-browsers/windows-installed-browsers', () => ({
  readWindowsInstalledBrowsers: readBrowsers
}))
vi.mock('../external-browsers/linux-installed-browsers', () => ({
  readLinuxInstalledBrowsers: readBrowsers
}))
vi.mock('../external-browsers/open-external-url', () => ({
  openExternalUrl,
  readConfiguredExternalBrowserId: () => 'com.microsoft.edgemac'
}))

const mainWindow = new BrowserWindow()
const BROWSERS: DetectedBrowser[] = [
  {
    id: 'com.google.Chrome',
    name: 'Google Chrome',
    launchCommand: () => ({ program: '', args: [] })
  },
  {
    id: 'com.microsoft.edgemac',
    name: 'Microsoft Edge',
    launchCommand: () => ({ program: '', args: [] })
  }
]

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** Fresh modules so each test starts with an empty browser catalog. */
async function loadModules(): Promise<{
  catalog: typeof CatalogModule
  installRichMarkdownLinkContextMenu: typeof RichMarkdownLinkMenuModule.installRichMarkdownLinkContextMenu
}> {
  vi.resetModules()
  return {
    catalog: await import('../external-browsers/installed-browser-catalog'),
    installRichMarkdownLinkContextMenu: (await import('./rich-markdown-link-context-menu'))
      .installRichMarkdownLinkContextMenu
  }
}

function params(
  overrides: Partial<Electron.ContextMenuParams> = {}
): Pick<Electron.ContextMenuParams, 'x' | 'y' | 'isEditable' | 'linkURL'> {
  return {
    x: 12,
    y: 34,
    isEditable: true,
    linkURL: 'https://github.com/o/r/pull/1',
    ...overrides
  }
}

describe('installRichMarkdownLinkContextMenu', () => {
  beforeEach(() => {
    ipcListeners.clear()
    openExternalUrl.mockClear()
    readBrowsers.mockReset()
  })

  it('offers Orca Browser only for the link the renderer reported, with the catalog loaded', async () => {
    const { catalog, installRichMarkdownLinkContextMenu } = await loadModules()
    readBrowsers.mockResolvedValue(BROWSERS)
    await catalog.listInstalledBrowsers()
    const menu = installRichMarkdownLinkContextMenu(mainWindow)
    ipcListeners.get(richMarkdownContextMenuLinkTargetChannel)?.(
      { sender: mainWindow.webContents },
      {
        x: 12,
        y: 34
      }
    )
    const open = vi.fn()

    menu.withLinkActions(params(), open)
    expect(open).toHaveBeenCalledTimes(1)

    const link = open.mock.calls[0][0]
    expect(link).toMatchObject({ canOpenInOrca: true, externalDefaultName: 'Microsoft Edge' })
    expect(link.browsers.map((browser: { name: string }) => browser.name)).toEqual([
      'Google Chrome',
      'Microsoft Edge'
    ])
    link.openUrl('https://github.com/o/r/pull/1', 'com.google.Chrome')
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/o/r/pull/1', {
      browserId: 'com.google.Chrome'
    })

    const next = vi.fn()
    menu.withLinkActions(params(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toMatchObject({ canOpenInOrca: false })
  })

  it('opens the link menu immediately while the browser catalog is still loading', async () => {
    const { installRichMarkdownLinkContextMenu } = await loadModules()
    readBrowsers.mockReturnValue(deferred<DetectedBrowser[]>().promise)
    const menu = installRichMarkdownLinkContextMenu(mainWindow)
    const open = vi.fn()

    menu.withLinkActions(params(), open)

    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0][0]).toMatchObject({ browsers: [], externalDefaultName: null })
  })

  it('never reopens an earlier menu when a slow catalog scan finishes', async () => {
    const { catalog, installRichMarkdownLinkContextMenu } = await loadModules()
    const scan = deferred<DetectedBrowser[]>()
    readBrowsers.mockReturnValue(scan.promise)
    const menu = installRichMarkdownLinkContextMenu(mainWindow)
    const opened: string[] = []

    menu.withLinkActions(params(), () => opened.push('first'))
    menu.withLinkActions(params({ x: 50 }), () => opened.push('second'))
    expect(opened).toEqual(['first', 'second'])
    menu.reset()
    scan.resolve(BROWSERS)
    await catalog.listInstalledBrowsers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(opened).toEqual(['first', 'second'])
  })

  it('opens the plain menu immediately off an http(s) link', async () => {
    const { installRichMarkdownLinkContextMenu } = await loadModules()
    const menu = installRichMarkdownLinkContextMenu(mainWindow)
    const open = vi.fn()

    menu.withLinkActions(params({ linkURL: '' }), open)
    menu.withLinkActions(params({ linkURL: 'mailto:someone@example.com' }), open)

    expect(open.mock.calls).toEqual([[], []])
  })
})
