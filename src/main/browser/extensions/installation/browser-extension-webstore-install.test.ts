import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
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

vi.mock('../../../telemetry/browser-extensions-banner', () => ({
  recordBrowserExtensionInstalled: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => state.userData, on: vi.fn() } }))
vi.mock('../tabs-and-windows/browser-extension-options-page', () => ({
  openBrowserExtensionOptionsPage: vi.fn()
}))
vi.mock('../web-store/browser-extension-webstore-updater', () => ({
  reviewHeldBrowserExtensionUpdate: vi.fn()
}))
vi.mock('../browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('../../sessions/profiles/browser-session-registry', () => ({
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
vi.mock('../profile-sessions/browser-extension-session-loader', () => ({
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
  it('keeps the old version when the new one fails to load', async () => {
    await installVersion('1.0.0')
    state.load.mockImplementation(async (_profileId, extension) => {
      if (extension.version === '1.1.0') {
        throw new Error('Manifest is not valid')
      }
      return {}
    })

    await expect(installVersion('1.1.0', null)).rejects.toThrow('Manifest is not valid')

    expect(store().get(extensionId)?.version).toBe('1.0.0')
    expect(readdirSync(root())).toEqual(['1.0.0'])
  })

  it('keeps another installed extension when a concurrent new install fails', async () => {
    const otherKey = generateCrxTestKey('ecdsa')
    const otherId = extensionIdFromPublicKey(otherKey.publicKeyDer)
    const other: VerifiedCrx = {
      extensionId: otherId,
      publicKey: otherKey.publicKeyDer,
      archive: Buffer.from(
        zipSync({
          'manifest.json': strToU8(
            JSON.stringify({ name: 'Notes', version: '1.0.0', manifest_version: 3 })
          )
        })
      )
    }
    let failFirst: (error: Error) => void = () => {}
    state.load.mockImplementation((_profileId, extension) =>
      extension.id === extensionId
        ? new Promise((_resolve, reject) => (failFirst = reject))
        : Promise.resolve({})
    )

    const failing = installVersion('1.0.0')
    await vi.waitFor(() => expect(store().get(extensionId)).not.toBeNull())
    await install.commitStagedWebStoreExtension(
      await install.stageWebStoreExtension(other),
      'default'
    )
    failFirst(new Error('Manifest is not valid'))
    await expect(failing).rejects.toThrow('Manifest is not valid')

    expect(store().get(extensionId)).toBeNull()
    expect(store().get(otherId)).not.toBeNull()
  })
})
