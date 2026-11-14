import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { extensionIdFromPublicKey, type VerifiedCrx } from './browser-extension-crx'
import { generateCrxTestKey, type CrxTestKey } from './browser-extension-crx-fixture'
import type * as InstallStoreModule from './browser-extension-install-store'
import type * as InstallModule from './browser-extension-webstore-install'
import type * as MutationLockModule from './browser-extension-mutation-lock'

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
let mutationLock: typeof MutationLockModule
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
  mutationLock = await import('./browser-extension-mutation-lock')
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
  it('never deletes a version while another profile is still enabling it', async () => {
    const first = await installVersion('1.0.0')
    const staged = await install.stageWebStoreExtension(crx('1.1.0'))
    const { setBrowserExtensionEnabled } = await import('../browser-extension-management')
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
        mutationLock.withBrowserExtensionLock(extensionId, () =>
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
})
