import type * as NodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const ID = 'a'.repeat(32)

const mocks = vi.hoisted(() => {
  const loaded = new Map<string, { id: string }>()
  const prepared: { signature: string | null; hasWorker: boolean } = {
    signature: 'v1',
    hasWorker: false
  }
  const registrationListeners = new Set<(event: unknown, details: { scope: string }) => void>()
  return {
    userData: '',
    prepared,
    loaded,
    registrationListeners,
    emitWorkerStart: vi.fn(),
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
      getStoragePath: () => null,
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
  session: { fromPartition: () => mocks.session }
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  // The preload sits beside the built main bundle, which tests do not have.
  existsSync: () => true
}))
vi.mock('./browser-extension-api-host', () => ({
  attachBrowserExtensionApiHostToSession: vi.fn(),
  forgetBrowserExtensionContexts: vi.fn(),
  emitBrowserExtensionWorkerStartEvent: mocks.emitWorkerStart
}))
vi.mock('./browser-extension-load-directory', () => ({
  prepareBrowserExtensionDirectory: async () => ({
    directory: '/orca/copy',
    extensionId: 'a'.repeat(32),
    workerSignature: mocks.prepared.signature,
    hasWorker: mocks.prepared.hasWorker
  })
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-loader-'))

const { setBrowserExtensionSupportEnabled } = await import('./browser-extension-support')
const loader = await import('./browser-extension-session-loader')
const { getBrowserExtensionLoadFailure } = await import('./browser-extension-load-errors')

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
    mocks.prepared.signature = 'v3'
    mocks.prepared.hasWorker = true
    loader.unloadBrowserExtensionFromProfile('default', ID)
    let settled = false
    const loading = loader
      .loadBrowserExtensionIntoProfile('default', installed, 'reload')
      .then(() => (settled = true))
    await vi.waitFor(() => expect(mocks.session.extensions.loadExtension).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    mocks.prepared.hasWorker = true
    mocks.emitWorkerStart.mockClear()
    mocks.session.clearStorageData.mockClear()
    loader.unloadBrowserExtensionFromProfile('default', ID)
    let settled = false
    const loading = loader
      .loadBrowserExtensionIntoProfile('default', installed, 'reload')
      .then(() => (settled = true))
    await vi.waitFor(() => expect(mocks.registrationListeners.size).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
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
