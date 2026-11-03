import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL,
  type BrowserExtensionWebStoreInstallResult
} from '../../../shared/browser-extension-webstore'
import type * as PromptModule from './browser-extension-install-prompt'
import type * as ServiceModule from './browser-extension-webstore-service'
import type * as InstallModule from './browser-extension-webstore-install'

const state = vi.hoisted(() => ({
  userData: '',
  load: vi.fn(async () => {}),
  download: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  webContents: { fromId: () => null }
}))
vi.mock('../browser-manager', () => ({ browserManager: {} }))
vi.mock('../browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: () => ({ label: 'Work' }),
    getEnabledExtensionIds: () => [],
    updateEnabledExtensionIds: vi.fn()
  }
}))
vi.mock('./browser-extension-management', () => ({ removeBrowserExtension: vi.fn() }))
vi.mock('./browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: () => ({}),
  loadBrowserExtensionIntoProfile: () => state.load(),
  unloadBrowserExtensionEverywhere: vi.fn()
}))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('./browser-extension-webstore-download', () => ({
  downloadWebStoreCrx: () => state.download(),
  fetchWebStoreIconDataUrl: vi.fn(),
  isAllowedWebStoreIconUrl: vi.fn()
}))
vi.mock('./browser-extension-webstore-events', () => ({
  notifyChromeWebStoreInstalled: vi.fn(),
  notifyChromeWebStoreUninstalled: vi.fn()
}))
vi.mock('./browser-extension-load-directory', () => ({
  refuseOrcaFileCollisions: vi.fn(async () => {})
}))
vi.mock('./browser-extension-held-updates', () => ({
  forgetHeldBrowserExtensionUpdate: vi.fn(),
  getHeldBrowserExtensionUpdate: () => null
}))
vi.mock('./browser-extension-list-changes', () => ({ notifyBrowserExtensionListChanged: vi.fn() }))
vi.mock('./browser-extension-profile-reload', () => ({
  reloadBrowserExtensionWhereEnabled: vi.fn()
}))

const extensionId = 'a'.repeat(32)
const renderers: EventEmitter[] = []
const installs: Promise<BrowserExtensionWebStoreInstallResult>[] = []
let service: typeof ServiceModule
let prompt: typeof PromptModule
let install: typeof InstallModule

function renderer() {
  const contents = Object.assign(new EventEmitter(), {
    id: 41,
    isDestroyed: () => false,
    send: vi.fn<(channel: string, payload: { requestId: string }) => void>()
  })
  renderers.push(contents)
  return contents
}

function asContents(contents: ReturnType<typeof renderer>): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt reads only these EventEmitter methods, id, isDestroyed and send.
  return contents as unknown as Electron.WebContents
}

function start(contents: ReturnType<typeof renderer>) {
  const pending = service.installBrowserExtensionFromWebStore(
    'work',
    extensionId,
    asContents(contents)
  )
  installs.push(pending)
  return pending
}

async function requested(contents: ReturnType<typeof renderer>): Promise<{ requestId: string }> {
  await vi.waitFor(() =>
    expect(contents.send).toHaveBeenCalledWith(
      BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL,
      expect.objectContaining({ kind: 'install', name: 'Vault' })
    )
  )
  const request = contents.send.mock.calls.find(
    ([channel]) => channel === BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL
  )?.[1]
  if (!request) {
    throw new Error('Install prompt missing')
  }
  return request
}

function stagedFolders(): string[] {
  return readdirSync(join(state.userData, 'browser-extensions', extensionId)).filter((name) =>
    name.startsWith('.staging-')
  )
}

beforeEach(async () => {
  state.userData = mkdtempSync(join(tmpdir(), 'orca-settings-prompt-'))
  state.load.mockReset()
  state.load.mockResolvedValue(undefined)
  state.download.mockReset()
  state.download.mockResolvedValue({
    extensionId,
    publicKey: Buffer.from('verified-download-key'),
    archive: Buffer.from(
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            name: 'Vault',
            version: '1.0',
            manifest_version: 3,
            permissions: ['storage']
          })
        )
      })
    )
  })
  vi.resetModules()
  service = await import('./browser-extension-webstore-service')
  prompt = await import('./browser-extension-install-prompt')
  install = await import('./browser-extension-webstore-install')
})

afterEach(async () => {
  for (const contents of renderers.splice(0)) {
    contents.emit('destroyed')
  }
  await Promise.all(installs.splice(0))
  rmSync(state.userData, { recursive: true, force: true })
})

describe('Settings extension install prompt lifetime', () => {
  it('discards staging and releases the install lock when the renderer reloads', async () => {
    const contents = renderer()
    const pending = start(contents)
    const request = await requested(contents)
    expect(stagedFolders()).toHaveLength(1)
    expect(install.isBrowserExtensionBusy(extensionId)).toBe(true)

    contents.emit('did-navigate', {}, 'file:///orca/index.html', 200, 'OK')

    await vi.waitFor(() => expect(install.isBrowserExtensionBusy(extensionId)).toBe(false))
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(stagedFolders()).toEqual([])
    expect(install.isBrowserExtensionBusy(extensionId)).toBe(false)
    expect(
      prompt.respondToBrowserExtensionInstallPrompt(asContents(contents), {
        requestId: request.requestId,
        accepted: true
      })
    ).toBe(false)
    for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
      expect(contents.listenerCount(event)).toBe(0)
    }

    const successor = renderer()
    const retry = start(successor)
    const next = await requested(successor)
    prompt.respondToBrowserExtensionInstallPrompt(asContents(successor), {
      requestId: next.requestId,
      accepted: true
    })
    await expect(retry).resolves.toEqual({ status: 'installed', name: 'Vault' })
    expect(install.isBrowserExtensionBusy(extensionId)).toBe(false)
  })

  it('finishes an accepted install when the renderer navigates during loading', async () => {
    let finishLoading = (): void => {}
    state.load.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLoading = resolve
        })
    )
    const contents = renderer()
    const pending = start(contents)
    const request = await requested(contents)
    prompt.respondToBrowserExtensionInstallPrompt(asContents(contents), {
      requestId: request.requestId,
      accepted: true
    })
    try {
      await vi.waitFor(() => expect(state.load).toHaveBeenCalledOnce())
      contents.emit('did-navigate', {}, 'file:///orca/index.html', 200, 'OK')
      expect(install.isBrowserExtensionBusy(extensionId)).toBe(true)
    } finally {
      finishLoading()
    }
    await expect(pending).resolves.toEqual({ status: 'installed', name: 'Vault' })
    expect(install.isBrowserExtensionBusy(extensionId)).toBe(false)
  })
})
