import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { extensionIdFromPublicKey, type VerifiedCrx } from './browser-extension-crx'
import { generateCrxTestKey, type CrxTestKey } from './browser-extension-crx-fixture'
import type * as InstallStoreModule from './browser-extension-install-store'
import type * as InstallModule from './browser-extension-webstore-install'

const state = vi.hoisted(() => {
  const enabled: Record<string, string[]> = {}
  return {
    userData: '',
    enabled,
    load: vi.fn(
      async (_profileId: string, _extension: InstalledBrowserExtension): Promise<unknown> => ({})
    )
  }
})

vi.mock('electron', () => ({ app: { getPath: () => state.userData, on: vi.fn() } }))
vi.mock('./api/runtime', () => ({ openBrowserExtensionOptionsPage: vi.fn() }))
vi.mock('./browser-extension-webstore-updater', () => ({
  reviewHeldBrowserExtensionUpdate: vi.fn()
}))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('../browser-session-registry', () => ({
  browserSessionRegistry: {
    listProfiles: () => [{ id: 'default' }, { id: 'work' }],
    getProfile: (id: string) => ({ id }),
    getEnabledExtensionIds: (profileId: string) => state.enabled[profileId] ?? [],
    updateEnabledExtensionIds: (
      update: (value: Record<string, string[]>) => Record<string, string[]>
    ) => {
      state.enabled = update(state.enabled)
    }
  }
}))
vi.mock('./browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: (profileId: string) =>
    profileId === 'default' ? {} : null,
  loadBrowserExtensionIntoProfile: (profileId: string, extension: InstalledBrowserExtension) =>
    state.load(profileId, extension),
  unloadBrowserExtensionEverywhere: vi.fn(),
  unloadBrowserExtensionFromProfile: vi.fn()
}))

let key: CrxTestKey
let extensionId: string
let install: typeof InstallModule
let installStore: typeof InstallStoreModule

beforeAll(() => {
  key = generateCrxTestKey('ecdsa')
  extensionId = extensionIdFromPublicKey(key.publicKeyDer)
})

beforeEach(async () => {
  state.userData = mkdtempSync(join(tmpdir(), 'orca-webstore-install-'))
  state.enabled = {}
  state.load.mockReset()
  state.load.mockImplementation(async () => ({}))
  vi.resetModules()
  install = await import('./browser-extension-webstore-install')
  installStore = await import('./browser-extension-install-store')
})
afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
})

function crx(version: string, permissions: string[] = ['storage']): VerifiedCrx {
  const manifest = { name: 'Vault', version, manifest_version: 3, permissions }
  return {
    extensionId,
    publicKey: key.publicKeyDer,
    archive: Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'bg.js': strToU8(version) })
    )
  }
}

function root(): string {
  return join(state.userData, 'browser-extensions', extensionId)
}

function store() {
  return installStore.getBrowserExtensionInstallStore()
}

async function installVersion(version: string, profileId: string | null = 'default') {
  const staged = await install.stageWebStoreExtension(crx(version))
  return install.commitStagedWebStoreExtension(staged, profileId)
}

describe('store installs', () => {
  it('installs into <id>/<version> with the key Electron needs to keep the id', async () => {
    const record = await installVersion('1.0.0')

    expect(record.path).toBe(join(root(), '1.0.0'))
    expect(readdirSync(root())).toEqual(['1.0.0'])
    const manifest = JSON.parse(readFileSync(join(record.path, 'manifest.json'), 'utf8'))
    expect(manifest.key).toBe(key.publicKeyDer.toString('base64'))
    expect(store().get(extensionId)).toMatchObject({ version: '1.0.0', source: 'webstore' })
    expect(state.load).toHaveBeenCalledWith('default', record)
    expect(state.enabled.default).toEqual([extensionId])
  })

  it('updates side by side, reloads where enabled, then deletes the old version', async () => {
    const first = await installVersion('1.0.0')
    state.load.mockClear()

    const second = await installVersion('1.1.0', null)

    expect(state.load).toHaveBeenCalledWith('default', second)
    expect(existsSync(first.path)).toBe(false)
    expect(readdirSync(root())).toEqual(['1.1.0'])
    expect(store().get(extensionId)?.version).toBe('1.1.0')
  })

  it('never deletes a version while another profile is still enabling it', async () => {
    const first = await installVersion('1.0.0')
    const staged = await install.stageWebStoreExtension(crx('1.1.0'))
    const { setBrowserExtensionEnabled } = await import('./browser-extension-management')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    state.load.mockImplementation(async (profileId) => {
      if (profileId === 'work') {
        await gate
      }
      return {}
    })
    const enabling = setBrowserExtensionEnabled('work', extensionId, true)
    await vi.waitFor(() => expect(state.load).toHaveBeenCalledWith('work', first))
    try {
      await expect(
        install.withBrowserExtensionLock(extensionId, () =>
          install.commitStagedWebStoreExtension(staged, null)
        )
      ).rejects.toThrow('already being installed')
      expect(existsSync(first.path)).toBe(true)
      expect(store().get(extensionId)?.version).toBe('1.0.0')
    } finally {
      release()
      expect(await enabling).toEqual({ ok: true })
      await install.discardStagedWebStoreExtension(staged)
    }
  })

  it('keeps the old version when the new one fails to load', async () => {
    const first = await installVersion('1.0.0')
    state.load.mockImplementation(async (_profileId, extension) => {
      if (extension.version === '1.1.0') {
        throw new Error('Manifest is not valid')
      }
      return {}
    })

    await expect(installVersion('1.1.0', null)).rejects.toThrow('Manifest is not valid')

    expect(store().get(extensionId)?.version).toBe('1.0.0')
    expect(readdirSync(root())).toEqual(['1.0.0'])
    expect(state.load).toHaveBeenLastCalledWith('default', first)
  })

  it('reuses the loaded folder when the same version is installed again', async () => {
    const first = await installVersion('1.0.0')
    const again = await installVersion('1.0.0', 'work')

    expect(again.path).toBe(first.path)
    expect(readdirSync(root())).toEqual(['1.0.0'])
  })

  it('removes a fresh install that fails to load', async () => {
    state.load.mockRejectedValue(new Error('boom'))

    await expect(installVersion('1.0.0')).rejects.toThrow('boom')

    expect(store().get(extensionId)).toBeNull()
    expect(existsSync(root())).toBe(false)
  })

  it('refuses to replace an unpacked extension with the same id', async () => {
    store().save({
      id: extensionId,
      name: 'Vault (dev)',
      version: '0.1',
      path: '/src/vault',
      source: 'unpacked',
      iconPath: null,
      permissions: [],
      hostPermissions: [],
      optionsPage: null
    })

    await expect(installVersion('1.0.0')).rejects.toThrow('loaded unpacked')
    expect(existsSync(root()) ? readdirSync(root()) : []).toEqual([])
  })

  it('stages what the prompt shows: name, version and access', async () => {
    const staged = await install.stageWebStoreExtension(crx('2.0', ['tabs', 'https://*/*']))

    expect(staged).toMatchObject({
      version: '2.0',
      summary: { name: 'Vault' },
      access: { permissions: ['tabs'], hostPermissions: ['https://*/*'] }
    })
    await install.discardStagedWebStoreExtension(staged)
    expect(readdirSync(root())).toEqual([])
  })

  it('refuses a package that ships a file where Orca writes its backup manifest', async () => {
    const shown = { name: 'Vault', version: '1.0', manifest_version: 3, permissions: [] }
    const hidden = { ...shown, permissions: ['tabs'], host_permissions: ['<all_urls>'] }
    await expect(
      install.stageWebStoreExtension({
        extensionId,
        publicKey: key.publicKeyDer,
        archive: Buffer.from(
          zipSync({
            'manifest.json': strToU8(JSON.stringify(shown)),
            'orca-original-manifest.json': strToU8(JSON.stringify(hidden))
          })
        )
      })
    ).rejects.toThrow('uses a name Orca reserves')
    expect(readdirSync(root())).toEqual([])
  })
})

describe('withBrowserExtensionLock', () => {
  it('refuses a second operation on the same extension while one runs', async () => {
    let release: () => void = () => {}
    const first = install.withBrowserExtensionLock(
      'a'.repeat(32),
      () => new Promise<void>((resolve) => (release = resolve))
    )
    await expect(install.withBrowserExtensionLock('a'.repeat(32), async () => {})).rejects.toThrow(
      install.BrowserExtensionBusyError
    )
    release()
    await first
    await expect(install.withBrowserExtensionLock('a'.repeat(32), async () => 1)).resolves.toBe(1)
  })
})
