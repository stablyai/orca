import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceSessionState,
  WorkspaceSessionPatch
} from '../../shared/workspace-session-state-types'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type * as RuntimeEnvironmentStore from '../../shared/runtime-environment-store'

const { handlers, clearStorage, authority } = vi.hoisted(() => ({
  authority: { userDataPath: '', reads: 0 },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  clearStorage: vi.fn(async () => ({ clearedPartitions: [], livePartitions: [] }))
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => authority.userDataPath || tmpdir(),
    getName: () => 'orca-audit',
    getVersion: () => '0.0.0',
    isPackaged: false,
    on() {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../browser/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForEnvironment: clearStorage
}))

vi.mock('../../shared/runtime-environment-store', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeEnvironmentStore>()
  return {
    ...original,
    listEnvironments: (...args: Parameters<typeof original.listEnvironments>) => {
      authority.reads++
      return original.listEnvironments(...args)
    }
  }
})

const { Store } = await import('../persistence/loading-store/store')
const { registerRuntimeEnvironmentConnectivityHandlers } =
  await import('./runtime-environment-connectivity-handlers')
const { registerSessionHandlers } = await import('./session')
const { registerRendererShutdownCheckpointHandler } = await import('./renderer-shutdown-checkpoint')
const {
  addEnvironmentFromPairingCode,
  listEnvironments,
  updateEnvironmentFromPairingCode,
  getEnvironmentStorePath
} = await import('../../shared/runtime-environment-store')
const { encodePairingOffer } = await import('../../shared/pairing')
const { getDefaultWorkspaceSession } = await import('../../shared/constants')
const { toRuntimeExecutionHostId } = await import('../../shared/execution-host')
const cleanups: (() => void)[] = []
beforeEach(() => {
  authority.reads = 0
  vi.restoreAllMocks()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-partition-audit-'))
  authority.userDataPath = dir
  const dataFile = join(dir, 'orca-data.json')
  const store = new Store({ dataFile })
  const invalidateTransport = vi.fn(async () => {})
  registerRuntimeEnvironmentConnectivityHandlers({
    store,
    getUserDataPath: () => dir,
    invalidateTransport
  })
  registerSessionHandlers(store)
  registerRendererShutdownCheckpointHandler(store)
  cleanups.push(() => {
    store.flush()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dataFile, store, invalidateTransport }
}

function pair(dir: string, name: string) {
  return addEnvironmentFromPairingCode(dir, {
    name,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://192.0.2.10:6768',
      deviceToken: 'audit-inert',
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })
  })
}

function session(id: string): WorkspaceSessionState {
  const worktreeId = `repo-a::/audit/${id}`
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: `tab-${id}`,
          worktreeId,
          ptyId: null,
          title: 'Audit',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
}

function unpair(
  dir: string,
  store: InstanceType<typeof Store>,
  environment: KnownRuntimeEnvironment
) {
  handlers.get('runtimeEnvironments:remove')!(null, { selector: environment.id })
  expect(listEnvironments(dir).some((entry) => entry.id === environment.id)).toBe(false)
  expect(store.getWorkspaceSessionHostIds()).not.toContain(toRuntimeExecutionHostId(environment.id))
  authority.reads = 0
}

async function invokeWrite(
  channel: string,
  state: WorkspaceSessionState | WorkspaceSessionPatch,
  hostId?: string
) {
  const event: { returnValue?: unknown } = {}
  if (channel === 'app:stage-before-unload-sync') {
    handlers.get(channel)!(event, { sessions: [{ state, hostId }], ui: {} })
    return handlers.get('app:await-before-unload-checkpoint')!()
  }
  await handlers.get(channel)!(event, state, hostId)
  return event.returnValue
}

describe('renderer session partition admission', () => {
  it.each(['session:set', 'session:patch', 'session:set-sync', 'app:stage-before-unload-sync'])(
    'rejects late %s after actual GUI unpair',
    async (channel) => {
      const { dir, store } = fixture()
      const environment = pair(dir, 'retired')
      const hostId = toRuntimeExecutionHostId(environment.id)
      store.setWorkspaceSession(session('before'), hostId)
      unpair(dir, store, environment)
      await invokeWrite(
        channel,
        channel === 'session:patch' ? { activeTabId: 'late' } : session('late'),
        hostId
      )
      expect(store.getWorkspaceSessionHostIds()).not.toContain(hostId)
      expect(authority.reads).toBe(1)
    }
  )

  it('consults disk for the first valid runtime partition and not its next 64 scalar patches', async () => {
    const { dir, store } = fixture()
    const environment = pair(dir, 'live')
    const hostId = toRuntimeExecutionHostId(environment.id)
    await invokeWrite('session:set', session('created'), hostId)
    expect(authority.reads).toBe(1)
    for (let index = 0; index < 64; index++) {
      await invokeWrite('session:patch', { activeTabId: `tab-${index}` }, hostId)
    }
    expect(authority.reads).toBe(1)
    expect(store.getWorkspaceSession(hostId).activeTabId).toBe('tab-63')
  })

  it('preserves local and direct SSH writes without consulting pairing authority', async () => {
    const { store } = fixture()
    for (const hostId of [undefined, 'local', 'ssh:unpaired-ssh']) {
      await invokeWrite('session:set', session(hostId ?? 'omitted'), hostId)
      expect(Object.keys(store.getWorkspaceSession(hostId).tabsByWorktree)).toHaveLength(1)
    }
    expect(authority.reads).toBe(0)
  })

  it('retains disconnected and repaired same-ID partitions', async () => {
    const { dir, store } = fixture()
    const environment = pair(dir, 'repair')
    const hostId = toRuntimeExecutionHostId(environment.id)
    await invokeWrite('session:set', session('before'), hostId)
    handlers.get('runtimeEnvironments:disconnect')!(null, { selector: environment.id })
    const pairingCode = encodePairingOffer({
      v: 2,
      endpoint: 'ws://192.0.2.11:6768',
      deviceToken: 'audit-repair',
      publicKeyB64: Buffer.alloc(32, 2).toString('base64')
    })
    const repaired = updateEnvironmentFromPairingCode(dir, environment.id, { pairingCode })
    expect(repaired.id).toBe(environment.id)
    authority.reads = 0
    await invokeWrite('session:patch', { activeTabId: 'after-repair' }, hostId)
    expect(authority.reads).toBe(0)
    expect(store.getWorkspaceSession(hostId).activeTabId).toBe('after-repair')
  })

  it('keeps a newly paired same-name ID and rejects the old ID even when used as another pair name', async () => {
    const { dir, store } = fixture()
    const prior = pair(dir, 'same-name')
    const oldHost = toRuntimeExecutionHostId(prior.id)
    store.setWorkspaceSession(session('old'), oldHost)
    unpair(dir, store, prior)
    const next = pair(dir, 'same-name')
    pair(dir, prior.id)
    expect(next.id).not.toBe(prior.id)
    await invokeWrite('session:set', session('old-late'), oldHost)
    await invokeWrite('session:set', session('new'), toRuntimeExecutionHostId(next.id))
    expect(store.getWorkspaceSessionHostIds()).not.toContain(oldHost)
    expect(store.getWorkspaceSessionHostIds()).toContain(toRuntimeExecutionHostId(next.id))
  })

  it('keeps existing historical runtime partitions writable without assuming their suffix is a paired ID', async () => {
    const { store } = fixture()
    store.setWorkspaceSession(session('legacy'), 'runtime:reported-runtime-id')
    await invokeWrite(
      'session:patch',
      { activeTabId: 'still-owned' },
      'runtime:reported-runtime-id'
    )
    expect(authority.reads).toBe(0)
    expect(store.getWorkspaceSession('runtime:reported-runtime-id').activeTabId).toBe('still-owned')
  })

  it('stages every shutdown session, including a host whose authority is unreadable', async () => {
    const { dir, store, dataFile } = fixture()
    const environment = pair(dir, 'new')
    const hostId = toRuntimeExecutionHostId(environment.id)
    const knownHost = 'runtime:known-existing'
    store.setWorkspaceSession(session('known-before'), knownHost)
    writeFileSync(getEnvironmentStorePath(dir), '{broken')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const event: { returnValue?: unknown } = {}
    handlers.get('app:stage-before-unload-sync')!(event, {
      sessions: [
        { state: session('unverifiable'), hostId },
        { state: session('local-after'), hostId: 'local' },
        { state: session('ssh-after'), hostId: 'ssh:target' },
        { state: session('known-after'), hostId: knownHost }
      ],
      ui: { sidebarWidth: 477 }
    })
    expect(event.returnValue).toEqual({ ok: true })
    await expect(handlers.get('app:await-before-unload-checkpoint')!()).resolves.toEqual({
      ok: true
    })
    expect(error).toHaveBeenCalledWith(
      '[app] Staging session state after partition authority failure:',
      expect.any(Error)
    )
    const disk = JSON.parse(readFileSync(dataFile, 'utf8'))
    expect(disk.ui.sidebarWidth).toBe(477)
    expect(Object.keys(disk.workspaceSession.tabsByWorktree)).toEqual([
      'repo-a::/audit/local-after'
    ])
    expect(Object.keys(disk.workspaceSessionsByHostId[hostId].tabsByWorktree)).toEqual([
      'repo-a::/audit/unverifiable'
    ])
    expect(Object.keys(disk.workspaceSessionsByHostId['ssh:target'].tabsByWorktree)).toEqual([
      'repo-a::/audit/ssh-after'
    ])
    expect(Object.keys(disk.workspaceSessionsByHostId[knownHost].tabsByWorktree)).toEqual([
      'repo-a::/audit/known-after'
    ])
  })

  it('stages a shutdown session whose namespace custody verdict is ambiguous', async () => {
    const { store, dataFile } = fixture()
    vi.spyOn(store, 'getRepos').mockImplementationOnce(() => {
      throw new Error('folder_workspace_connection_ambiguous')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const event: { returnValue?: unknown } = {}
    handlers.get('app:stage-before-unload-sync')!(event, {
      sessions: [{ state: session('ambiguous'), hostId: 'runtime:ambiguous' }],
      ui: {}
    })
    expect(event.returnValue).toEqual({ ok: true })
    await expect(handlers.get('app:await-before-unload-checkpoint')!()).resolves.toEqual({
      ok: true
    })
    const disk = JSON.parse(readFileSync(dataFile, 'utf8'))
    expect(Object.keys(disk.workspaceSessionsByHostId['runtime:ambiguous'].tabsByWorktree)).toEqual(
      ['repo-a::/audit/ambiguous']
    )
  })

  it('keeps existing no-flush behavior for actual staging errors', async () => {
    const { store } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(store, 'stageWorkspaceSessionBeforeUnload').mockImplementation(() => {
      throw new Error('actual-stage-error')
    })
    const flush = vi.spyOn(store, 'flushPendingOrThrowAsync')
    const event: { returnValue?: unknown } = {}
    handlers.get('app:stage-before-unload-sync')!(event, {
      sessions: [{ state: session('local') }],
      ui: {}
    })
    expect(event.returnValue).toEqual({ ok: false })
    expect(flush).not.toHaveBeenCalled()
    await expect(handlers.get('app:await-before-unload-checkpoint')!()).resolves.toEqual({
      ok: false
    })
  })
})

describe('bounded paired mirror retirement', () => {
  it('keeps 32 pair/unpair cycles absent in memory, disk, and reload', async () => {
    const { dir, store, dataFile, invalidateTransport } = fixture()
    const retiredHosts: string[] = []
    for (let index = 0; index < 32; index++) {
      const environment = pair(dir, `cycle-${index}`)
      const hostId = toRuntimeExecutionHostId(environment.id)
      retiredHosts.push(hostId)
      await invokeWrite('session:set', session(`cycle-${index}`), hostId)
      expect(store.getWorkspaceSessionHostIds()).toContain(hostId)
      unpair(dir, store, environment)
      await invokeWrite('session:patch', { activeTabId: 'late' }, hostId)
    }
    expect(listEnvironments(dir)).toEqual([])
    expect(invalidateTransport).toHaveBeenCalledTimes(32)
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])
    store.flushOrThrow()
    const disk = JSON.parse(readFileSync(dataFile, 'utf8'))
    for (const hostId of retiredHosts) {
      expect(disk.workspaceSessionsByHostId[hostId]).toBeUndefined()
    }
    const reloaded = new Store({ dataFile })
    expect(reloaded.getWorkspaceSessionHostIds()).toEqual(['local'])
    reloaded.freezeWrites()
  })
})

describe('removal failure ordering', () => {
  it('writes and acknowledges the legacy sync channel when admission authority is unreadable', async () => {
    const { dir, store, dataFile } = fixture()
    const environment = pair(dir, 'unreadable')
    const hostId = toRuntimeExecutionHostId(environment.id)
    const knownHost = 'runtime:known-existing'
    store.setWorkspaceSession(session('known-before'), knownHost)
    store.setWorkspaceSession(session('local-pending'))
    writeFileSync(getEnvironmentStorePath(dir), '{broken')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(invokeWrite('session:set-sync', session('unverifiable'), hostId)).resolves.toBe(
      true
    )
    const disk = JSON.parse(readFileSync(dataFile, 'utf8'))
    expect(Object.keys(disk.workspaceSession.tabsByWorktree)).toEqual([
      'repo-a::/audit/local-pending'
    ])
    expect(Object.keys(disk.workspaceSessionsByHostId[hostId].tabsByWorktree)).toEqual([
      'repo-a::/audit/unverifiable'
    ])
    const readsAfterFailure = authority.reads
    await expect(invokeWrite('session:set-sync', session('known-after'), knownHost)).resolves.toBe(
      true
    )
    expect(authority.reads).toBe(readsAfterFailure)
    expect(Object.keys(store.getWorkspaceSession(knownHost).tabsByWorktree)).toEqual([
      'repo-a::/audit/known-after'
    ])
  })

  it('preserves Store write failures on the legacy sync channel', async () => {
    const { store } = fixture()
    vi.spyOn(store, 'setWorkspaceSession').mockImplementationOnce(() => {
      throw new Error('controlled Store write failure')
    })
    await expect(invokeWrite('session:set-sync', session('local'), 'local')).rejects.toThrow(
      'controlled Store write failure'
    )
  })

  it.each(['controlled custody read failure', 'folder_workspace_connection_ambiguous'])(
    'unpairs but preserves the session partition when custody reports %s',
    (message) => {
      const base = fixture()
      const environment = pair(base.dir, 'custody-failure')
      const hostId = toRuntimeExecutionHostId(environment.id)
      base.store.setWorkspaceSession(session('before'), hostId)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(base.store, 'getRepos').mockImplementation(() => {
        throw new Error(message)
      })
      const removal = vi.spyOn(base.store, 'removeRuntimeWorkspaceSessionPartition')
      expect(
        handlers.get('runtimeEnvironments:remove')!(null, { selector: environment.id })
      ).toMatchObject({ removed: { id: environment.id } })
      expect(listEnvironments(base.dir).some((entry) => entry.id === environment.id)).toBe(false)
      expect(base.invalidateTransport).toHaveBeenCalledWith(environment.id)
      expect(removal).not.toHaveBeenCalled()
      expect(base.store.getWorkspaceSessionHostIds()).toContain(hostId)
      expect(Object.keys(base.store.getWorkspaceSession(hostId).tabsByWorktree)).toEqual([
        'repo-a::/audit/before'
      ])
      expect(warn).toHaveBeenCalledWith(
        '[runtime-environments] Preserving session partition after custody lookup failure:',
        expect.any(Error)
      )
    }
  )

  it('starts transport and browser retirement even if exact Store partition deletion fails', async () => {
    const base = fixture()
    const environment = pair(base.dir, 'store-deletion-failure')
    const hostId = toRuntimeExecutionHostId(environment.id)
    base.store.setWorkspaceSession(session('before'), hostId)
    clearStorage.mockClear()
    vi.spyOn(base.store, 'removeRuntimeWorkspaceSessionPartition').mockImplementation(() => {
      throw new Error('controlled partition deletion failure')
    })
    expect(() =>
      handlers.get('runtimeEnvironments:remove')!(null, { selector: environment.id })
    ).toThrow('controlled partition deletion failure')
    expect(listEnvironments(base.dir)).toEqual([])
    expect(base.invalidateTransport).toHaveBeenCalledWith(environment.id)
    await vi.waitFor(() => expect(clearStorage).toHaveBeenCalledWith(environment.id))
    expect(base.store.getWorkspaceSessionHostIds()).toContain(hostId)
  })
})

describe('async session admission failures', () => {
  it.each(['session:set', 'session:patch'])(
    'still writes %s when the pairing catalog cannot be read',
    async (channel) => {
      const { dir, store } = fixture()
      const environment = pair(dir, 'unreadable')
      const hostId = toRuntimeExecutionHostId(environment.id)
      writeFileSync(getEnvironmentStorePath(dir), '{broken')
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(invokeWrite(channel, session('unverifiable'), hostId)).resolves.toBeUndefined()
      expect(store.getWorkspaceSessionHostIds()).toContain(hostId)
      expect(Object.keys(store.getWorkspaceSession(hostId).tabsByWorktree)).toEqual([
        'repo-a::/audit/unverifiable'
      ])
      expect(error).toHaveBeenCalledWith(
        '[session] Admitting session write after partition authority failure:',
        expect.any(Error)
      )
    }
  )

  it.each(['session:set', 'session:patch'])(
    'still writes %s when main namespace custody is ambiguous',
    async (channel) => {
      const { store } = fixture()
      vi.spyOn(store, 'getRepos').mockImplementationOnce(() => {
        throw new Error('folder_workspace_connection_ambiguous')
      })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(
        invokeWrite(channel, session('unverifiable'), 'runtime:unverifiable')
      ).resolves.toBeUndefined()
      expect(Object.keys(store.getWorkspaceSession('runtime:unverifiable').tabsByWorktree)).toEqual(
        ['repo-a::/audit/unverifiable']
      )
    }
  )

  it('still writes session:set-sync when main namespace custody is ambiguous', async () => {
    const { store } = fixture()
    vi.spyOn(store, 'getRepos').mockImplementationOnce(() => {
      throw new Error('folder_workspace_connection_ambiguous')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      invokeWrite('session:set-sync', session('ambiguous'), 'runtime:ambiguous')
    ).resolves.toBe(true)
    expect(Object.keys(store.getWorkspaceSession('runtime:ambiguous').tabsByWorktree)).toEqual([
      'repo-a::/audit/ambiguous'
    ])
  })

  it.each(['session:set', 'session:patch'])(
    'preserves actual Store failures for %s',
    async (channel) => {
      const { store } = fixture()
      const method = channel === 'session:set' ? 'setWorkspaceSession' : 'patchWorkspaceSession'
      vi.spyOn(store, method).mockImplementationOnce(() => {
        throw new Error('actual Store write failure')
      })
      await expect(invokeWrite(channel, session('local'), 'local')).rejects.toThrow(
        'actual Store write failure'
      )
    }
  )
})
