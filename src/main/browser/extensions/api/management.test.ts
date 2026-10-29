import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../../shared/browser-extension-types'
import type { BrowserExtensionCaller } from '../browser-extension-namespace-registry'

const mocks = vi.hoisted(() => {
  const installed: InstalledBrowserExtension[] = []
  return {
    installed,
    enabled: new Set<string>(),
    gesture: false,
    setEnabled: vi.fn(),
    notify: vi.fn()
  }
})

vi.mock('../../browser-session-registry', () => ({
  browserSessionRegistry: { getEnabledExtensionIds: () => [...mocks.enabled] }
}))
vi.mock('../browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ list: () => mocks.installed })
}))
vi.mock('../browser-extension-management', () => ({
  setBrowserExtensionEnabled: mocks.setEnabled
}))
vi.mock('../browser-extension-list-changes', () => ({
  notifyBrowserExtensionListChanged: mocks.notify
}))
vi.mock('./permissions', () => ({ hasBrowserExtensionUserGesture: () => mocks.gesture }))

const registry = await import('../browser-extension-namespace-registry')
const { registerManagementNamespace } = await import('./management')

const SELF = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

function installed(id: string, source: 'webstore' | 'unpacked'): InstalledBrowserExtension {
  return {
    id,
    name: id === SELF ? 'Vault' : 'Blocker',
    version: '2.1',
    path: '/x',
    source,
    iconPath: 'icon.png',
    permissions: ['storage'],
    hostPermissions: ['https://*/*'],
    optionsPage: id === OTHER ? 'options.html' : null
  }
}

const loaded = new Map([
  [
    OTHER,
    {
      manifest: {
        description: 'Blocks things',
        short_name: 'Blk',
        icons: { '16': 'i16.png', '128': '/i128.png' }
      }
    }
  ]
])

function call(method: string, args: unknown[]) {
  const caller = {
    extension: { id: SELF },
    session: { extensions: { getExtension: (id: string) => loaded.get(id) ?? null } },
    browserProfileId: 'default'
  }
  const target = registry.getBrowserExtensionNamespace('management')?.methods[method]
  return new Promise((resolve) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: management reads the caller's extension id, profile and session.extensions, all stubbed.
    resolve(target?.invoke(caller as unknown as BrowserExtensionCaller, args))
  )
}

beforeEach(() => {
  registerManagementNamespace()
  mocks.installed = [installed(SELF, 'webstore'), installed(OTHER, 'unpacked')]
  mocks.enabled = new Set([SELF, OTHER])
  mocks.gesture = false
  mocks.setEnabled.mockReset().mockResolvedValue({ ok: true })
  mocks.notify.mockReset()
})

describe('chrome.management', () => {
  it("lists the profile's installed extensions as Chrome's ExtensionInfo", async () => {
    mocks.enabled.delete(SELF)
    await expect(call('getAll', [])).resolves.toEqual([
      expect.objectContaining({ id: SELF, enabled: false, disabledReason: 'unknown' }),
      {
        id: OTHER,
        name: 'Blocker',
        shortName: 'Blk',
        description: 'Blocks things',
        version: '2.1',
        mayDisable: true,
        enabled: true,
        isApp: false,
        type: 'extension',
        offlineEnabled: false,
        optionsUrl: `chrome-extension://${OTHER}/options.html`,
        icons: [
          { size: 16, url: `chrome-extension://${OTHER}/i16.png` },
          { size: 128, url: `chrome-extension://${OTHER}/i128.png` }
        ],
        permissions: ['storage'],
        hostPermissions: ['https://*/*'],
        installType: 'development'
      }
    ])
    await expect(call('get', [SELF])).resolves.toMatchObject({ installType: 'normal' })
    await expect(call('get', ['c'.repeat(32)])).rejects.toThrow(
      `Failed to find extension with id ${'c'.repeat(32)}.`
    )
  })

  it('turns other extensions off, and on only from a user gesture', async () => {
    await call('setEnabled', [OTHER, false])
    expect(mocks.setEnabled).toHaveBeenCalledWith('default', OTHER, false)
    expect(mocks.notify).toHaveBeenCalledTimes(1)

    mocks.enabled.delete(OTHER)
    await expect(call('setEnabled', [OTHER, true])).rejects.toThrow(
      'This function must be called during a user gesture'
    )
    mocks.gesture = true
    await call('setEnabled', [OTHER, true])
    expect(mocks.setEnabled).toHaveBeenLastCalledWith('default', OTHER, true)

    await expect(call('setEnabled', [SELF, false])).rejects.toThrow(
      'An extension cannot enable or disable itself'
    )
    mocks.enabled.add(OTHER)
    mocks.setEnabled.mockResolvedValueOnce({ ok: false, error: 'Browser profile not found' })
    await expect(call('setEnabled', [OTHER, false])).rejects.toThrow('Browser profile not found')
  })
})
