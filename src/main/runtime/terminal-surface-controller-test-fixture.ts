import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'
import type { BrowserTabCreatePublicationHost } from './browser/tabs/browser-tab-create-publication'
import {
  createBrowserClientPage,
  type BrowserClientPageCreateParams
} from './browser/client-pages/browser-client-page-opening'
import { getBrowserHostLeaseRegistry } from './browser-host/leases/browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './browser/client-pages/runtime-browser-page-registry'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { Store } from '../persistence/loading-store/store'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../shared/constants'
import { emptySurfaceHostDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import { profileStateDatabaseFile } from '../../shared/profile-state-storage-paths'
import { prepareProfileStateStore } from '../persistence/profile-state/profile-state-store-factory'
import { surfaceAdmissionRegistry } from '../workspace-surfaces/surface-admission-capture'

export function installPhysicalController(f: {
  runtime: OrcaRuntimeService
  store: Store
  directory: string
}) {
  const processes = new Map<string, { id: string; cwd: string; title: string }>()
  let nextResourceId: string | undefined
  f.runtime.setPtyController({
    spawn: async (args) => {
      const id = nextResourceId ?? `physical-${randomUUID()}`
      nextResourceId = undefined
      const incarnationId = randomUUID()
      if (!args.worktreeId || !args.tabId || !args.leafId || !args.surfaceRunTarget) {
        throw new Error('expected an admitted canonical pane')
      }
      await f.store.executeWorkspaceSurfaceCommand({
        type: 'begin-run',
        hostId: 'local',
        target: args.surfaceRunTarget,
        resourceId: id
      })
      expect(
        await f.store.persistPtyBinding({
          worktreeId: args.worktreeId,
          tabId: args.tabId,
          leafId: args.leafId,
          surfaceRunTarget: args.surfaceRunTarget,
          ptyId: id,
          incarnationId
        })
      ).toBe(true)
      processes.set(id, { id, cwd: f.directory, title: 'sh' })
      f.runtime.onPtySpawned(id, incarnationId)
      f.runtime.registerPty(id, args.worktreeId, args.connectionId ?? null, {
        tabId: args.tabId,
        leafId: args.leafId,
        incarnationId,
        ...(args.preAllocatedHandle ? { terminalHandle: args.preAllocatedHandle } : {})
      })
      return { id, incarnationId }
    },
    listProcesses: async () => [...processes.values()],
    write: () => true,
    kill: (id) => processes.delete(id),
    stopAndWait: async (id) => {
      processes.delete(id)
      return true
    },
    getForegroundProcess: async () => null
  })
  return {
    processes,
    reuseNextId: (id: string) => {
      nextResourceId = id
    }
  }
}

export async function openPairedClientBrowserPage(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  options: Pick<BrowserClientPageCreateParams, 'activate' | 'targetGroupId'> = { activate: false }
) {
  const authority = getBrowserHostLeaseRegistry(runtime)
  authority.attach({
    browserHostClientId: 'paired-browser',
    connectionId: 'browser-connection',
    pairedDeviceId: 'desktop',
    hostCapabilities: ['webview']
  })
  const placement = vi.spyOn(authority, 'createClientPage').mockImplementation(async (input) => {
    const placed = authority.placeClientPage(input.browserPageId, input.browserHostClientId)
    if (placed.kind !== 'client') {
      throw new Error('expected client placement')
    }
    return placed
  })
  const markHeadlessBrowserSessionTabActive: NonNullable<
    BrowserTabCreatePublicationHost['markHeadlessBrowserSessionTabActive']
  > = (workspace, page, selection) =>
    runtime['markHeadlessBrowserSessionTabActive'](workspace, page, selection)
  const browser = await createBrowserClientPage(
    {
      getAgentBrowserBridge: () => null,
      resolveBrowserWorkspace: async () => ({ id: worktreeId }),
      resolveBrowserNetworkExecutionHost: async () => ({
        kind: 'native',
        runtimeId: 'test-runtime',
        revision: 1
      }),
      getBrowserHostLeaseRegistry: () => authority,
      getRuntimeBrowserPageRegistry: () => getRuntimeBrowserPageRegistry(runtime),
      notifyHeadlessBrowserSessionTabsChanged: () =>
        runtime.notifyMobileSessionTabsChanged(worktreeId),
      markHeadlessBrowserSessionTabActive
    },
    { ...options, placement: { kind: 'client', browserHostClientId: 'paired-browser' } },
    {
      worktree: { id: worktreeId },
      browserProfileId: 'default',
      caller: { pairedDeviceId: 'desktop', clientKind: 'runtime' }
    }
  )
  placement.mockRestore()
  return browser
}

export function createTerminalSurfaceByRpc(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  pane: { tabId: string; leafId: string }
) {
  const method = TERMINAL_LIFECYCLE_METHODS.find(
    (candidate) => candidate.name === 'terminal.create'
  )
  if (!method) {
    throw new Error('terminal.create method missing')
  }
  return method.handler(
    { worktree: `id:${worktreeId}`, ...pane },
    { runtime, pairedDeviceId: 'old-desktop', clientKind: 'runtime' }
  )
}

export async function createCanonicalSurfaceRuntimeFixture(
  directories: string[],
  ownedStores: Store[],
  nullTabId?: string
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-canonical-fence-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const databasePath = profileStateDatabaseFile(directory)
  if (nullTabId) {
    const state = getDefaultPersistedState(directory)
    const host = emptySurfaceHostDomain()
    host.terminalInitialized = true
    host.surfaces = [
      {
        hostId: 'local',
        workspaceId: `repo-1::${directory}`,
        hostTabId: nullTabId,
        occurrence: 'old-null',
        revision: 1,
        createdAt: 1,
        content: null
      }
    ]
    state.workspaceSurfaces = { version: 1, hosts: { local: host } }
    writeFileSync(dataFile, JSON.stringify(state))
  }
  const { initialState } = prepareProfileStateStore({
    dataFile,
    databaseFile: databasePath,
    profileId: 'fence-experiment'
  })
  const authority = initialState.authority
  const store = new Store({
    dataFile,
    profileStateAuthority: authority,
    initialAuthorityState: initialState
  })
  store.initializeWorkspaceSurfacesSync()
  ownedStores.push(store)
  const repo = {
    id: 'repo-1',
    path: directory,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  }
  store.addRepo(repo)
  const worktreeId = `${repo.id}::${repo.path}`
  if (!nullTabId) {
    await store.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId: 'local' })
  }
  expect(store.workspaceSurfacesInitialized()).toBe(true)
  const runtime = new OrcaRuntimeService(store)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: worktreeId,
      path: directory,
      connectionId: null,
      repo,
      folderWorkspace: null
    }))
  })
  const spawn = vi.fn(async () => ({ id: `physical-${randomUUID()}` }))
  runtime.setPtyController({
    spawn,
    listProcesses: async () => [],
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const create = (pane: { tabId: string; leafId: string }, currentRuntime = runtime) =>
    createTerminalSurfaceByRpc(currentRuntime, worktreeId, pane)
  const close = (tabId: string) =>
    runtime.closeTerminalSurfaceFromRenderer({
      worktreeId,
      target: { kind: 'tab', tabId },
      reason: 'user'
    })
  return {
    store,
    authority,
    registry: surfaceAdmissionRegistry(store['runtime'].workspaceSurfaces!),
    dataFile,
    runtime,
    create,
    close,
    worktreeId,
    spawn,
    repo,
    directory
  }
}
