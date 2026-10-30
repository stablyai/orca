import type * as NodeFs from 'node:fs'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ID = 'a'.repeat(32)

const mocks = vi.hoisted(() => {
  const loaded = new Map<string, { id: string }>()
  const prepared: { signature: string | null; hasWorker: boolean } = {
    signature: 'v1',
    hasWorker: false
  }
  const registrationListeners = new Set<(event: unknown, details: { scope: string }) => void>()
  /** Holds prepareBrowserExtensionDirectory until released, to land a load late. */
  const prepareGate: { held: Promise<void> | null } = { held: null }
  const storage: { path: string | null } = { path: null }
  return {
    userData: '',
    storage,
    prepareGate,
    prepareCalls: 0,
    prepared,
    loaded,
    registrationListeners,
    emitWorkerStart: vi.fn(),
    uninstalled: vi.fn(),
    session: {
      serviceWorkers: {
        on: (_name: string, listener: (event: unknown, details: { scope: string }) => void) =>
          registrationListeners.add(listener),
        removeListener: (
          _name: string,
          listener: (event: unknown, details: { scope: string }) => void
        ) => registrationListeners.delete(listener)
      },
      registerPreloadScript: vi.fn(),
      unregisterPreloadScript: vi.fn(),
      getStoragePath: () => mocks.storage.path,
      clearStorageData: vi.fn(async () => {}),
      extensions: {
        getExtension: (id: string) => loaded.get(id) ?? null,
        getAllExtensions: () => [...loaded.values()],
        loadExtension: vi.fn(async () => {
          const extension = {
            id: 'a'.repeat(32),
            version: '1.0',
            manifest: prepared.hasWorker ? { background: { service_worker: 'bg.js' } } : {}
          }
          loaded.set(extension.id, extension)
          return extension
        }),
        removeExtension: (id: string) => loaded.delete(id)
      }
    }
  }
})

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => mocks.userData },
  session: {
    fromPartition: (partition: string) =>
      partition === 'persist:orca-browser-retired'
        ? {
            ...mocks.session,
            extensions: {
              ...mocks.session.extensions,
              getExtension: () => null,
              getAllExtensions: () => []
            }
          }
        : mocks.session
  }
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  // The preload sits beside the built main bundle, which tests do not have.
  existsSync: () => true
}))
vi.mock('./browser-extension-api-host', () => ({
  attachBrowserExtensionApiHostToSession: vi.fn(),
  forgetBrowserExtensionContexts: vi.fn(),
  getBrowserExtensionProfileIdForSession: vi.fn(() => null),
  emitBrowserExtensionWorkerStartEvent: mocks.emitWorkerStart
}))
vi.mock('./browser-extension-load-directory', () => ({
  prepareBrowserExtensionDirectory: async () => {
    mocks.prepareCalls++
    await mocks.prepareGate.held
    return {
      directory: '/orca/copy',
      extensionId: 'a'.repeat(32),
      workerSignature: mocks.prepared.signature,
      hasWorker: mocks.prepared.hasWorker
    }
  }
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-loader-'))

const { setBrowserExtensionSupportEnabled } = await import('./browser-extension-support')
const loader = await import('./browser-extension-session-loader')
const { getBrowserExtensionLoadFailure } = await import('./browser-extension-load-errors')
const { getBrowserExtensionProfileStateStore } =
  await import('./browser-extension-profile-state-store')
const { getBrowserExtensionSyncStorageStore } =
  await import('./browser-extension-sync-storage-store')
const { getBrowserExtensionInstallStore } = await import('./browser-extension-install-store')
const { getBrowserExtensionActionState } = await import('./browser-extension-action-registry')
const realFs = await vi.importActual<typeof NodeFs>('node:fs')

const installed = {
  id: ID,
  name: 'Vault',
  version: '1.0',
  path: '/store/vault/1.0',
  source: 'webstore' as const,
  iconPath: null,
  permissions: [],
  hostPermissions: [],
  optionsPage: null
}

describe('browser extension session loader', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers only the frame preload, never a service-worker preload (electron#52310)', () => {
    setBrowserExtensionSupportEnabled(true)
    loader.attachBrowserExtensionsToProfileSession(
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-browser',
        label: 'Default',
        source: null
      },
      []
    )
    const types = mocks.session.registerPreloadScript.mock.calls.map(([options]) => options.type)
    expect(types).toEqual(['frame'])
  })

  it('drops the cached worker registration only when the worker scripts changed', async () => {
    await loader.loadBrowserExtensionIntoProfile('default', installed)
    expect(mocks.session.clearStorageData).toHaveBeenCalledWith({
      origin: `chrome-extension://${ID}`,
      storages: ['serviceworkers']
    })
    expect(mocks.session.extensions.loadExtension).toHaveBeenCalledWith('/orca/copy', {
      allowFileAccess: false
    })

    mocks.session.clearStorageData.mockClear()
    loader.unloadBrowserExtensionFromProfile('default', ID)
    await loader.loadBrowserExtensionIntoProfile('default', installed)
    expect(mocks.session.clearStorageData).not.toHaveBeenCalled()

    mocks.prepared.signature = 'v2'
    loader.unloadBrowserExtensionFromProfile('default', ID)
    await loader.loadBrowserExtensionIntoProfile('default', installed)
    expect(mocks.session.clearStorageData).toHaveBeenCalledTimes(1)
  })

  it('always re-registers an unpacked worker, whose folder may have changed', async () => {
    mocks.prepared.signature = null
    mocks.session.clearStorageData.mockClear()
    for (let load = 0; load < 2; load++) {
      loader.unloadBrowserExtensionFromProfile('default', ID)
      await loader.loadBrowserExtensionIntoProfile('default', {
        ...installed,
        source: 'unpacked'
      })
    }
    expect(mocks.session.clearStorageData).toHaveBeenCalledTimes(2)
  })

  it('raises lifecycle events only once Chromium has registered the dropped worker again', async () => {
    vi.useFakeTimers()
    mocks.prepared.signature = 'v3'
    mocks.prepared.hasWorker = true
    loader.unloadBrowserExtensionFromProfile('default', ID)
    let settled = false
    const loading = loader
      .loadBrowserExtensionIntoProfile('default', installed, 'reload')
      .then(() => (settled = true))
    await vi.waitFor(() => expect(mocks.registrationListeners.size).toBe(1))
    await vi.advanceTimersByTimeAsync(20)
    // Starting the worker now would fail: "Failed to start service worker."
    expect(settled).toBe(false)
    expect(mocks.emitWorkerStart).not.toHaveBeenCalled()

    for (const listener of mocks.registrationListeners) {
      listener({}, { scope: 'chrome-extension://other/' })
      listener({}, { scope: `chrome-extension://${ID}/` })
    }
    await loading
    expect(mocks.emitWorkerStart).toHaveBeenCalledWith(
      mocks.session,
      ID,
      'runtime',
      'onInstalled',
      [{ reason: 'update', previousVersion: '1.0' }]
    )
    expect(mocks.registrationListeners.size).toBe(0)
    mocks.prepared.hasWorker = false
  })

  it('waits for the worker to register again after an unload, even with unchanged scripts', async () => {
    vi.useFakeTimers()
    mocks.prepared.hasWorker = true
    mocks.emitWorkerStart.mockClear()
    mocks.session.clearStorageData.mockClear()
    loader.unloadBrowserExtensionFromProfile('default', ID)
    let settled = false
    const loading = loader
      .loadBrowserExtensionIntoProfile('default', installed, 'reload')
      .then(() => (settled = true))
    await vi.waitFor(() => expect(mocks.registrationListeners.size).toBe(1))
    await vi.advanceTimersByTimeAsync(20)
    expect(settled).toBe(false)
    expect(mocks.emitWorkerStart).not.toHaveBeenCalled()
    expect(mocks.session.clearStorageData).not.toHaveBeenCalled()

    for (const listener of mocks.registrationListeners) {
      listener({}, { scope: `chrome-extension://${ID}/` })
    }
    await loading
    expect(mocks.emitWorkerStart).toHaveBeenCalled()
    mocks.prepared.hasWorker = false
  })

  it('keeps the last load failure for Settings and clears it on the next good load', async () => {
    loader.unloadBrowserExtensionFromProfile('default', ID)
    mocks.session.extensions.loadExtension.mockRejectedValueOnce(
      new Error(
        "Loading extension at /orca/copy failed with: Could not load javascript 'cs.js' for script."
      )
    )
    await expect(loader.loadBrowserExtensionIntoProfile('default', installed)).rejects.toThrow()
    expect(getBrowserExtensionLoadFailure('default', ID)).toBe(
      "Could not load javascript 'cs.js' for script."
    )

    await loader.loadBrowserExtensionIntoProfile('default', installed)
    expect(getBrowserExtensionLoadFailure('default', ID)).toBeNull()
  })
})

describe('switching the experimental setting while Orca runs', () => {
  const profile = {
    id: 'default',
    scope: 'default' as const,
    partition: 'persist:orca-browser',
    label: 'Default',
    source: null
  }

  it('off unloads every extension and its preload; on wires the profile again', async () => {
    setBrowserExtensionSupportEnabled(true)
    loader.attachBrowserExtensionsToProfileSession(profile, [])
    await loader.loadBrowserExtensionIntoProfile('default', installed)
    expect(mocks.loaded.size).toBe(1)

    setBrowserExtensionSupportEnabled(false)
    await loader.detachBrowserExtensionsFromAllProfileSessions()
    expect(mocks.loaded.size).toBe(0)
    expect(mocks.session.unregisterPreloadScript).toHaveBeenCalledWith(
      'orca-browser-extension-frame'
    )
    expect(loader.getBrowserExtensionSessionForProfile('default')).toBeNull()

    mocks.session.registerPreloadScript.mockClear()
    setBrowserExtensionSupportEnabled(true)
    loader.attachBrowserExtensionsToProfileSession(profile, [])
    expect(mocks.session.registerPreloadScript).toHaveBeenCalledOnce()
    expect(loader.getBrowserExtensionSessionForProfile('default')).toBe(mocks.session)
  })
})

describe('profile changes while startup loads are in flight', () => {
  const profile = {
    id: 'default',
    scope: 'default' as const,
    partition: 'persist:orca-browser',
    label: 'Default',
    source: null
  }
  let release: () => void = () => {}

  /** Attaches with the extension enabled and holds its startup load before it reaches Chromium. */
  async function attachWithHeldStartupLoad(): Promise<void> {
    setBrowserExtensionSupportEnabled(true)
    await loader.detachBrowserExtensionsFromAllProfileSessions()
    mocks.session.extensions.loadExtension.mockClear()
    getBrowserExtensionInstallStore().save(installed)
    mocks.prepareGate.held = new Promise<void>((resolve) => (release = resolve))
    const calls = mocks.prepareCalls
    loader.attachBrowserExtensionsToProfileSession(profile, [ID])
    await vi.waitFor(() => expect(mocks.prepareCalls).toBe(calls + 1))
  }

  afterEach(() => {
    release()
    mocks.prepareGate.held = null
  })

  it('a disable that finishes first stops the late startup load before it writes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.prepared.signature = 'v-disable'
    await attachWithHeldStartupLoad()
    loader.unloadBrowserExtensionFromProfile('default', ID)
    release()
    await loader.whenBrowserExtensionProfileLoaded('default')
    expect(mocks.session.extensions.loadExtension).not.toHaveBeenCalled()
    expect(mocks.loaded.size).toBe(0)
    expect(getBrowserExtensionProfileStateStore().read('default', ID).workerSignature).not.toBe(
      'v-disable'
    )
  })

  it('an explicit load still in flight when extensions turn off fails and leaves nothing loaded', async () => {
    setBrowserExtensionSupportEnabled(true)
    await loader.detachBrowserExtensionsFromAllProfileSessions()
    loader.attachBrowserExtensionsToProfileSession(profile, [])
    await loader.whenBrowserExtensionProfileLoaded('default')
    mocks.prepareGate.held = new Promise<void>((resolve) => (release = resolve))
    const calls = mocks.prepareCalls
    const enabling = loader.loadBrowserExtensionIntoProfile('default', installed)
    await vi.waitFor(() => expect(mocks.prepareCalls).toBe(calls + 1))
    const detaching = loader.detachBrowserExtensionsFromAllProfileSessions()
    release()
    await expect(enabling).rejects.toThrow('turned off')
    await detaching
    expect(mocks.loaded.size).toBe(0)
  })

  it('profile delete purges saved data only after the startup loads stop writing', async () => {
    mocks.prepared.signature = 'v-delete'
    await attachWithHeldStartupLoad()
    const detaching = loader.detachBrowserExtensionsFromProfileSession(profile)
    release()
    await detaching
    expect(getBrowserExtensionProfileStateStore().readProfile('default')).toEqual({})
  })

  it('profile delete clears native extension settings even when extensions never attached', async () => {
    setBrowserExtensionSupportEnabled(false)
    await loader.detachBrowserExtensionsFromAllProfileSessions()
    const partition = mkdtempSync(join(tmpdir(), 'orca-extension-deleted-profile-'))
    const folder = join(partition, 'Local Extension Settings', ID)
    mkdirSync(folder, { recursive: true })
    mocks.storage.path = partition
    try {
      await loader.detachBrowserExtensionsFromProfileSession({
        ...profile,
        id: 'retired',
        partition: 'persist:orca-browser-retired'
      })
      expect(realFs.existsSync(folder)).toBe(false)
    } finally {
      mocks.storage.path = null
    }
  })

  it('profile delete purges saved data even when extensions never attached to it', async () => {
    setBrowserExtensionSupportEnabled(false)
    await loader.detachBrowserExtensionsFromAllProfileSessions()
    getBrowserExtensionSyncStorageStore().write('work', ID, { token: 'secret' })
    await loader.detachBrowserExtensionsFromProfileSession({ ...profile, id: 'work' })
    expect(getBrowserExtensionSyncStorageStore().read('work', ID)).toEqual({})
  })
})

describe('deleted profile action state', () => {
  it.each([
    ['unattached', false, false],
    ['attached', true, false],
    ['failed-unload', true, true]
  ] as const)('retires action payloads for %s', async (label, attached, failedUnload) => {
    const profileId = `action-retirement-${label}`
    const profile = {
      id: profileId,
      scope: 'isolated' as const,
      partition: `persist:orca-${profileId}`,
      label: 'Retired',
      source: null
    }
    const extension = {
      id: ID,
      name: 'Vault',
      path: installed.path,
      url: `chrome-extension://${ID}/`,
      version: installed.version,
      manifest: { action: { default_title: 'Fresh' } }
    }
    setBrowserExtensionSupportEnabled(true)
    if (attached) {
      loader.attachBrowserExtensionsToProfileSession(profile, [])
      await loader.whenBrowserExtensionProfileLoaded(profileId)
    }
    const removed = getBrowserExtensionActionState(profileId, extension)
    removed.set('title', 'Retired title')
    removed.set('icon', { kind: 'data', dataUrl: 'data:image/png;base64,retired' })
    removed.set('badgeText', 'Retired tab badge', 77)
    const survivor = getBrowserExtensionActionState(`survivor-${profileId}`, extension)
    survivor.set('title', 'Surviving title')

    if (failedUnload) {
      mocks.loaded.set(ID, { id: ID })
      const unload = vi
        .spyOn(mocks.session.extensions, 'removeExtension')
        .mockImplementationOnce(() => {
          throw new Error('native unload failed')
        })
      try {
        await expect(loader.detachBrowserExtensionsFromProfileSession(profile)).rejects.toThrow(
          'native unload failed'
        )
      } finally {
        unload.mockRestore()
        mocks.loaded.delete(ID)
      }
    } else {
      await loader.detachBrowserExtensionsFromProfileSession(profile)
    }

    const fresh = getBrowserExtensionActionState(profileId, extension)
    expect(fresh).not.toBe(removed)
    expect(fresh.get(77)).toMatchObject({ title: 'Fresh', icon: null, badgeText: '' })
    expect(getBrowserExtensionActionState(`survivor-${profileId}`, extension)).toBe(survivor)
    expect(survivor.get().title).toBe('Surviving title')
  })
})

it('does not restore stale enablement after uninstall and reinstall in another Orca profile', async () => {
  setBrowserExtensionSupportEnabled(true)
  await loader.detachBrowserExtensionsFromAllProfileSessions()
  loader.setBrowserExtensionSessionHooks({
    attached: () => {},
    detached: () => {},
    loaded: async () => {},
    uninstalled: mocks.uninstalled
  })
  const store = getBrowserExtensionInstallStore()
  store.save(installed)
  await store.remove(ID)
  store.save(installed)
  mocks.session.extensions.loadExtension.mockClear()
  loader.attachBrowserExtensionsToProfileSession(
    {
      id: 'inactive-profile',
      scope: 'isolated',
      partition: 'persist:orca-browser-inactive',
      label: 'Inactive',
      source: null
    },
    [ID]
  )
  await loader.whenBrowserExtensionProfileLoaded('inactive-profile')
  expect(mocks.session.extensions.loadExtension).not.toHaveBeenCalled()
  expect(mocks.uninstalled).toHaveBeenCalledWith('inactive-profile', new Set([ID]))

  await expect(
    loader.loadBrowserExtensionIntoProfile('inactive-profile', installed)
  ).rejects.toThrow('Restart Orca')
  expect(mocks.session.extensions.loadExtension).not.toHaveBeenCalled()
  await loader.detachBrowserExtensionsFromAllProfileSessions()
})
