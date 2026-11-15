import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
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
  const gate: { removeGate: Promise<void> | null } = { removeGate: null }
  return {
    userData: '',
    ...gate,
    enabled,
    load: vi.fn(
      async (_profileId: string, _extension: InstalledBrowserExtension): Promise<unknown> => ({})
    )
  }
})

vi.mock('../../../telemetry/browser-extensions-banner', () => ({
  recordBrowserExtensionInstalled: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await state.removeGate
      return actual.rm(...args)
    }
  }
})
vi.mock('../profile-sessions/browser-extension-runtime-lifecycle', () => ({
  fireRuntimeLifecycleEvents: vi.fn()
}))
vi.mock('../profile-sessions/browser-extension-session-load', () => ({
  loadInstalledBrowserExtensionIntoSession: async (
    _session: Electron.Session,
    profileId: string,
    extension: InstalledBrowserExtension
  ) => {
    await state.load(profileId, extension)
    return { id: extension.id }
  }
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
  state.removeGate = null
  state.load.mockReset()
  state.load.mockImplementation(async () => ({}))
  vi.resetModules()
  vi.doMock('../profile-sessions/browser-extension-session-loader', async () => {
    const { enableBrowserExtensionInProfile } =
      await import('../profile-sessions/browser-extension-profile-loading')
    const { admitBrowserExtensionEnable, revokeBrowserExtensionEnable } =
      await import('../profile-sessions/browser-extension-profile-session-state')
    return {
      admitBrowserExtensionEnable,
      revokeBrowserExtensionEnable,
      withBrowserExtensionProfileOperation: async (
        _profile: string,
        _id: string,
        run: (session: Electron.Session) => Promise<unknown>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture operation callback does not use native session members.
      ) => run({} as Electron.Session),
      enableBrowserExtensionInProfile,
      hasBrowserExtensionProfileDemand: () => true,
      getBrowserExtensionSessionForProfile: (profileId: string) =>
        profileId === 'default' ? {} : null,
      loadBrowserExtensionIntoProfile: (profileId: string, extension: InstalledBrowserExtension) =>
        state.load(profileId, extension),
      unloadBrowserExtensionEverywhere: vi.fn(),
      unloadBrowserExtensionFromProfile: vi.fn()
    }
  })
  install = await import('./browser-extension-webstore-install')
  installStore = await import('./browser-extension-install-store')
  const { stateByProfileId } =
    await import('../profile-sessions/browser-extension-profile-session-state')
  const { BrowserExtensionProfileLoads } =
    await import('../profile-sessions/browser-extension-profile-loads')
  const { attachBrowserExtensionProfileDemand } =
    await import('../profile-sessions/browser-extension-profile-demand')
  for (const id of ['default', 'work']) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Native loading is mocked; the real enable path only reads getExtension.
    const session = { extensions: { getExtension: () => null } } as unknown as Electron.Session
    const enabled = () => state.enabled[id] ?? []
    stateByProfileId.set(id, {
      profile: {
        id,
        scope: 'default',
        partition: `persist:${id}`,
        label: id,
        source: null
      },
      session,
      loads: new BrowserExtensionProfileLoads(),
      loading: Promise.resolve(),
      started: new Set(),
      enabled,
      enables: new Map()
    })
    attachBrowserExtensionProfileDemand(
      id,
      async () => {},
      async () => {},
      enabled
    )
  }
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
  it('discards an approved package when its profile disappears before commit', async () => {
    const staged = await install.stageWebStoreExtension(crx('1.0.0'))
    const { stateByProfileId } =
      await import('../profile-sessions/browser-extension-profile-session-state')
    stateByProfileId.delete('default')
    await expect(install.commitStagedWebStoreExtension(staged, 'default')).rejects.toThrow(
      'Browser profile is not available for extensions'
    )
    expect(existsSync(staged.directory)).toBe(false)
    expect(store().get(extensionId)).toBe(null)
  })

  it.each(['1.0.0', '1.1.0'])(
    'keeps an installed extension disabled when Disable overlaps the %s commit filesystem wait',
    async (version) => {
      await installVersion('1.0.0', null)
      const staged = await install.stageWebStoreExtension(crx(version))
      const { setBrowserExtensionEnabled } = await import('../browser-extension-management')
      let release = () => {}
      state.removeGate = new Promise<void>((resolve) => (release = resolve))
      const committing = install.commitStagedWebStoreExtension(staged, 'default')
      const rejected = expect(committing).rejects.toThrow(
        'The extension was turned off before it finished loading'
      )
      try {
        expect(await setBrowserExtensionEnabled('default', extensionId, false)).toEqual({
          ok: true
        })
      } finally {
        state.removeGate = null
        release()
      }
      await rejected

      expect(state.enabled.default).toEqual([])
      expect(store().get(extensionId)?.version).toBe('1.0.0')
      expect(readdirSync(root())).toEqual(['1.0.0'])
    }
  )

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
