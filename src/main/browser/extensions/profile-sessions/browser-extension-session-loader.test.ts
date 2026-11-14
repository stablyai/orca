import type * as NodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
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
    enabled: new Map<string, string[]>(),
    profileForSession: 'default',
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
      get storagePath() {
        return mocks.userData
      },
      registerPreloadScript: vi.fn(),
      unregisterPreloadScript: vi.fn(),
      getStoragePath: () => mocks.storage.path,
      clearStorageData: vi.fn(async () => {}),
      extensions: {
        on: vi.fn(),
        getExtension: (id: string) => loaded.get(id) ?? null,
        getAllExtensions: () => [...loaded.values()],
        loadExtension: vi.fn(async (directory: string) => {
          const extension = {
            id: directory.split('/').at(-1)!,
            path: '/orca/copy',
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

vi.mock('electron', () => {
  const inactiveSession = { ...mocks.session }
  return {
    app: { on: vi.fn(), getPath: () => mocks.userData },
    session: {
      fromPartition: (partition: string) =>
        partition === 'persist:orca-browser-inactive'
          ? inactiveSession
          : partition === 'persist:orca-browser-retired'
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
  }
})
vi.mock('../../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    getEnabledExtensionIds: (id: string) => mocks.enabled.get(id) ?? [],
    profileIdForSession: () => mocks.profileForSession
  }
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  // The preload sits beside the built main bundle, which tests do not have.
  existsSync: () => true
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  attachBrowserExtensionApiHostToSession: (sess: Electron.Session, id: string) =>
    contexts.ensureHostSessionState(sess, id),
  forgetBrowserExtensionContexts: (sess: Electron.Session) => contexts.forgetHostSession(sess),
  getBrowserExtensionProfileIdForSession: vi.fn(() => null),
  emitBrowserExtensionWorkerStartEvent: mocks.emitWorkerStart
}))
vi.mock('../installation/browser-extension-load-directory', () => ({
  prepareBrowserExtensionDirectory: async (extension: { id: string }) => {
    mocks.prepareCalls++
    await mocks.prepareGate.held
    return {
      directory: `/orca/copy/${extension.id}`,
      extensionId: extension.id,
      workerSignature: mocks.prepared.signature,
      hasWorker: mocks.prepared.hasWorker
    }
  }
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-loader-'))

const contexts = await import('../api-runtime/browser-extension-contexts')
const { setBrowserExtensionSupportEnabled } = await import('../browser-extension-support')
const loader = await import('./browser-extension-session-loader')
await import('./browser-extension-load-errors')
const { getBrowserExtensionProfileStateStore } =
  await import('../profile-storage/browser-extension-profile-state-store')
await import('../profile-storage/browser-extension-sync-storage-store')
const { getBrowserExtensionInstallStore } =
  await import('../installation/browser-extension-install-store')
const { getBrowserExtensionActionState } =
  await import('../actions/browser-extension-action-registry')

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
    mocks.enabled.set(profile.id, [ID])
    loader.attachBrowserExtensionsToProfileSession(profile, [ID])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
    const page = { session: mocks.session, once: vi.fn() } as unknown as Electron.WebContents
    void loader.retainBrowserExtensionPage(page).catch(() => {})
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
    const disabling = loader.unloadBrowserExtensionFromProfile('default', ID)
    release()
    await disabling
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
      getBrowserExtensionProfileStateStore().update(profileId, ID, (state) => ({
        ...state,
        workerSignature: 'left-behind'
      }))
      const unload = vi
        .spyOn(mocks.session.extensions, 'removeExtension')
        .mockImplementationOnce(() => {
          throw new Error('native unload failed')
        })
      try {
        await expect(loader.detachBrowserExtensionsFromProfileSession(profile)).rejects.toThrow(
          'native unload failed'
        )
        expect(getBrowserExtensionProfileStateStore().readProfile(profileId)).toEqual({})
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

it.each([750, 7500])(
  'keeps %i saved profiles cold through the session startup path',
  async (count) => {
    setBrowserExtensionSupportEnabled(true)
    await loader.detachBrowserExtensionsFromAllProfileSessions()
    getBrowserExtensionInstallStore().save(installed)
    mocks.session.extensions.loadExtension.mockClear()
    const preparedBefore = mocks.prepareCalls
    for (let index = 0; index < count; index++) {
      const id = `fleet-${count}-${index}`
      mocks.enabled.set(id, [ID])
      loader.attachBrowserExtensionsToProfileSession(
        {
          id,
          scope: 'isolated',
          partition: `persist:orca-${id}`,
          label: id,
          source: null
        },
        [ID]
      )
    }
    await loader.whenBrowserExtensionSessionsLoaded(1000)
    expect(mocks.prepareCalls - preparedBefore).toBe(0)
    expect(mocks.session.extensions.loadExtension).not.toHaveBeenCalled()
    mocks.profileForSession = `fleet-${count}-0`
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
      const page = { session: mocks.session, once: vi.fn() } as unknown as Electron.WebContents
      await loader.retainBrowserExtensionPage(page)
      expect(mocks.session.extensions.loadExtension.mock.calls).toEqual([
        [`/orca/copy/${ID}`, { allowFileAccess: false }]
      ])
      expect(mocks.prepareCalls - preparedBefore).toBe(1)
    } finally {
      mocks.profileForSession = 'default'
      await loader.detachBrowserExtensionsFromAllProfileSessions()
      for (let index = 0; index < count; index++) {
        mocks.enabled.delete(`fleet-${count}-${index}`)
      }
    }
  }
)

it('keeps pages usable when an enabled extension fails to load', async () => {
  setBrowserExtensionSupportEnabled(true)
  await loader.detachBrowserExtensionsFromAllProfileSessions()
  getBrowserExtensionInstallStore().save(installed)
  const healthy = { ...installed, id: 'b'.repeat(32), name: 'Healthy' }
  getBrowserExtensionInstallStore().save(healthy)
  const profile = {
    id: 'broken-extension-profile',
    scope: 'isolated' as const,
    partition: 'persist:orca-browser-broken-extension',
    label: 'Broken extension',
    source: null
  }
  mocks.enabled.set(profile.id, [ID, healthy.id])
  mocks.profileForSession = profile.id
  mocks.session.extensions.loadExtension.mockRejectedValueOnce(new Error('Invalid manifest'))
  loader.attachBrowserExtensionsToProfileSession(profile, [ID, healthy.id])
  try {
    for (let index = 0; index < 2; index++) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
      const page = { session: mocks.session, once: vi.fn() } as unknown as Electron.WebContents
      await expect(loader.retainBrowserExtensionPage(page)).resolves.toBeUndefined()
    }
    expect(mocks.loaded.has(healthy.id)).toBe(true)
  } finally {
    mocks.profileForSession = 'default'
    await loader.detachBrowserExtensionsFromAllProfileSessions()
  }
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
  await loader.withBrowserExtensionProfileOperation('inactive-profile', ID, async () => {})
  expect(mocks.session.extensions.loadExtension).not.toHaveBeenCalled()
  expect(mocks.uninstalled).toHaveBeenCalledWith('inactive-profile', new Set([ID]))

  // This cold session never opened the old database; an explicit enable may load the reinstall.
  await expect(
    loader.loadBrowserExtensionIntoProfile('inactive-profile', installed)
  ).resolves.toMatchObject({ id: ID })
  await loader.detachBrowserExtensionsFromAllProfileSessions()
})

it('reuses completed full maintenance until the install store changes, and scopes page-less cleanup to its target', async () => {
  const { EventEmitter } = await import('node:events')
  const store = getBrowserExtensionInstallStore()
  const states = getBrowserExtensionProfileStateStore()
  const profile = {
    id: 'maintenance',
    scope: 'isolated' as const,
    partition: 'persist:maintenance',
    label: 'Maintenance',
    source: null
  }
  setBrowserExtensionSupportEnabled(true)
  await loader.detachBrowserExtensionsFromAllProfileSessions()
  mocks.profileForSession = profile.id
  mocks.enabled.set(profile.id, [ID])
  mocks.prepareGate.held = null
  store.save(installed)
  loader.attachBrowserExtensionsToProfileSession(profile, [ID])
  const inventory = vi.spyOn(states, 'readProfile')
  const makePage = () =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
    Object.assign(new EventEmitter(), {
      session: mocks.session,
      isDestroyed: () => false
    }) as unknown as Electron.WebContents
  let tab = makePage()
  try {
    await loader.withBrowserExtensionProfileOperation(profile.id, ID, async () => {})
    expect(inventory).not.toHaveBeenCalled()
    await loader.retainBrowserExtensionPage(tab)
    expect(inventory).toHaveBeenCalledTimes(1)
    tab.emit('destroyed')
    tab = makePage()
    await loader.retainBrowserExtensionPage(tab)
    expect(inventory).toHaveBeenCalledTimes(1)
    tab.emit('destroyed')
    store.save({ ...installed, version: '1.1' })
    tab = makePage()
    await loader.retainBrowserExtensionPage(tab)
    expect(inventory).toHaveBeenCalledTimes(2)
  } finally {
    tab.emit('destroyed')
    inventory.mockRestore()
    await loader.detachBrowserExtensionsFromAllProfileSessions()
    mocks.profileForSession = 'default'
  }
})

it('skips repeated no-worker cleanup only after completion and invalidates it for every worker generation', async () => {
  const { refreshWorkerRegistration } = await import('./browser-extension-worker-registration')
  const clearStorageData = vi.fn(async () => {})
  const session = { clearStorageData } as unknown as Electron.Session
  const prepared = {
    extensionId: 'b'.repeat(32),
    directory: '/immutable/generation',
    workerSignature: null,
    hasWorker: false,
    release: async () => {}
  }
  await refreshWorkerRegistration(session, 'cleanup', prepared)
  await refreshWorkerRegistration(session, 'cleanup', prepared)
  expect(clearStorageData).toHaveBeenCalledTimes(1)
  await refreshWorkerRegistration(session, 'cleanup', { ...prepared, hasWorker: true })
  await refreshWorkerRegistration(session, 'cleanup', { ...prepared, hasWorker: true })
  expect(clearStorageData).toHaveBeenCalledTimes(3)
  await refreshWorkerRegistration(session, 'cleanup', prepared)
  await refreshWorkerRegistration(session, 'cleanup', prepared)
  expect(clearStorageData).toHaveBeenCalledTimes(4)
})
