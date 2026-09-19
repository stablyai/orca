import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, clearStorage, authority } = vi.hoisted(() => ({
  authority: { userDataPath: '', reads: 0 },
  handlers: new Map(),
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
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString()
  },
  ipcMain: {
    on: (name, handler) => handlers.set(name, handler),
    handle: (name, handler) => handlers.set(name, handler)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../../src/main/browser/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForEnvironment: clearStorage
}))

vi.mock('../../../src/shared/runtime-environment-store', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    listEnvironments: (...args) => {
      authority.reads++
      return original.listEnvironments(...args)
    }
  }
})

const { Store } = await import('../../../src/main/persistence/loading-store/store')
const { registerRuntimeEnvironmentConnectivityHandlers } =
  await import('../../../src/main/ipc/runtime-environment-connectivity-handlers')
const { registerSessionHandlers } = await import('../../../src/main/ipc/session')
const { registerRendererShutdownCheckpointHandler } =
  await import('../../../src/main/ipc/renderer-shutdown-checkpoint')
const { addEnvironmentFromPairingCode, listEnvironments, getEnvironmentStorePath } =
  await import('../../../src/shared/runtime-environment-store')
const { encodePairingOffer } = await import('../../../src/shared/pairing')
const { getDefaultWorkspaceSession } = await import('../../../src/shared/constants')
const { toRuntimeExecutionHostId } = await import('../../../src/shared/execution-host')
const cleanups = []
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
  registerSessionHandlers(store, undefined)
  registerRendererShutdownCheckpointHandler(store)
  cleanups.push(() => {
    store.flush()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dataFile, store, invalidateTransport }
}

function pair(dir, name) {
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

function session(id) {
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

import { RuntimeWorkspaceSessionController } from '../../../src/main/runtime/runtime-workspace-session-controller'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from '../../../src/main/runtime/runtime-legacy-worker-terminal-recovery-persistence'
import { persistClientHostedBrowserPages } from '../../../src/main/runtime/client-hosted-browser-page-persistence'
import { RuntimeBrowserPageRegistry } from '../../../src/main/runtime/runtime-browser-page-registry'

const variant = process.env.ORCA_PARTITION_VARIANT
if (!['before', 'fixed', 'without-rollback'].includes(variant)) {
  throw new Error('Unknown proof variant')
}
const fixed = variant !== 'before'
const rollbackGuard = variant === 'fixed'
const metrics = {}
afterAll(() => writeFileSync(process.env.ORCA_PARTITION_METRICS, JSON.stringify(metrics, null, 2)))
const WORKTREE = 'repo-a::/audit/worktree'
const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAB = 'legacy-worker-tab'
const PANE = `${TAB}:${LEAF}`
const INCARNATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function ownRepo(store, hostId) {
  store.addRepo({
    id: 'repo-a',
    path: '/audit',
    displayName: 'Audit',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: hostId,
    kind: 'folder'
  })
}
function controllerFor(store) {
  return new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: () => null,
    hasRuntimeOwnedPtyCandidate: () => false
  })
}
function retiringSession() {
  return {
    ...getDefaultWorkspaceSession(),
    activeTabId: TAB,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: TAB,
          worktreeId: WORKTREE,
          ptyId: 'pty-a',
          title: 'Audit',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-a' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [PANE]: INCARNATION },
    sleepingAgentSessionsByPaneKey: {
      [PANE]: {
        paneKey: PANE,
        tabId: TAB,
        worktreeId: WORKTREE,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'audit-codex' },
        prompt: 'continue',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  }
}
function recoveryCandidate() {
  return {
    dispatchId: 'dispatch-a',
    dispatchStatus: 'dispatched',
    contractVersion: 1,
    taskId: 'task-a',
    worktreeId: WORKTREE,
    terminalHandle: 'term-a',
    paneKey: PANE,
    tabId: TAB,
    leafId: LEAF,
    processIncarnation: `pty-a:${INCARNATION}`,
    ptyId: 'pty-a',
    incarnationId: INCARNATION
  }
}
function unpair(base, environment) {
  handlers.get('runtimeEnvironments:remove')(null, { selector: environment.id })
}
function isolateAbsentPartitionBeforeFix(store, hostId) {
  // Before has no removal API; isolate later-writer admission/rollback with an explicit simulated deletion.
  if (!fixed) {
    delete store.runtime.state.workspaceSessionsByHostId[hostId]
  }
}
async function invokeWrite(channel, state, hostId) {
  const event = {}
  if (channel === 'app:stage-before-unload-sync') {
    handlers.get(channel)(event, { sessions: [{ state, hostId }], ui: {} })
    return handlers.get('app:await-before-unload-checkpoint')()
  }
  await handlers.get(channel)(event, state, hostId)
  return event.returnValue
}

describe('actual GUI unpair persistence', () => {
  it('measures 32 completed pair/write/unpair cycles through memory, explicit flush, and reload', async () => {
    const base = fixture()
    for (let index = 0; index < 32; index++) {
      const environment = pair(base.dir, `cycle-${index}`)
      const hostId = toRuntimeExecutionHostId(environment.id)
      await invokeWrite('session:set', session(`cycle-${index}`), hostId)
      unpair(base, environment)
      await invokeWrite('session:patch', { activeTabId: 'late' }, hostId)
    }
    const memory = base.store.getWorkspaceSessionHostIds().length - 1
    base.store.flushOrThrow()
    const disk = Object.keys(
      JSON.parse(readFileSync(base.dataFile, 'utf8')).workspaceSessionsByHostId ?? {}
    ).length
    const reloaded = new Store({ dataFile: base.dataFile })
    const reload = reloaded.getWorkspaceSessionHostIds().length - 1
    reloaded.freezeWrites()
    metrics.cycles = {
      iterations: 32,
      memory,
      disk,
      reload,
      environmentCount: listEnvironments(base.dir).length,
      invalidations: base.invalidateTransport.mock.calls.length
    }
    expect(metrics.cycles).toEqual({
      iterations: 32,
      memory: fixed ? 0 : 32,
      disk: fixed ? 0 : 32,
      reload: fixed ? 0 : 32,
      environmentCount: 0,
      invalidations: 32
    })
  })

  it.each(['session:set', 'session:patch', 'session:set-sync', 'app:stage-before-unload-sync'])(
    'checks absent-partition late %s admission',
    async (channel) => {
      const base = fixture()
      const environment = pair(base.dir, channel)
      const hostId = toRuntimeExecutionHostId(environment.id)
      base.store.setWorkspaceSession(session('before'), hostId)
      unpair(base, environment)
      isolateAbsentPartitionBeforeFix(base.store, hostId)
      await invokeWrite(
        channel,
        channel === 'session:patch' ? { activeTabId: 'late' } : session('late'),
        hostId
      )
      const recreated = base.store.getWorkspaceSessionHostIds().includes(hostId)
      metrics[channel] = { recreated, beforeUsesSimulatedDeletion: !fixed }
      expect(recreated).toBe(!fixed)
    }
  )

  it('preserves exact same-ID main repository custody and its browser callback', () => {
    const base = fixture()
    const environment = pair(base.dir, 'same-id-namespace')
    const hostId = toRuntimeExecutionHostId(environment.id)
    ownRepo(base.store, hostId)
    base.store.setWorkspaceSession(retiringSession(), hostId)
    const controller = controllerFor(base.store)
    const registry = new RuntimeBrowserPageRegistry()
    registry.publishClientPage({
      browserPageId: 'page-a',
      workspaceId: WORKTREE,
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:1',
      placement: {
        kind: 'client',
        browserHostClientId: 'host-a',
        browserHostGeneration: 1,
        pageHostGeneration: 1
      },
      pairedDeviceId: 'device-a',
      url: 'https://example.invalid/',
      title: 'Owned page',
      loading: false,
      active: false
    })
    unpair(base, environment)
    expect(base.store.getWorkspaceSessionHostIds()).toContain(hostId)
    expect(
      persistClientHostedBrowserPages(
        {
          getWorkspaceSession: (id) => controller.get(id),
          setWorkspaceSession: (id, value) => controller.set(id, value)
        },
        registry,
        WORKTREE
      )
    ).toBe(true)
    expect(
      base.store.getWorkspaceSession(hostId).clientHostedBrowserPagesByWorktree[WORKTREE]
    ).toHaveLength(1)
  })

  it('preserves the unique old namespace selected by the actual controller', () => {
    const base = fixture()
    const environment = pair(base.dir, 'old-stamp')
    const hostId = toRuntimeExecutionHostId(environment.id)
    ownRepo(base.store, 'runtime:current-self-stamp')
    base.store.setWorkspaceSession(retiringSession(), hostId)
    expect(controllerFor(base.store).getHostId(WORKTREE)).toBe(hostId)
    unpair(base, environment)
    expect(base.store.getWorkspaceSessionHostIds()).toContain(hostId)
  })

  it.each(['adopted', 'exited'])(
    'records failed %s recovery after catalog removal and unpair',
    async (resolution) => {
      const base = fixture()
      const environment = pair(base.dir, 'recovery')
      const hostId = toRuntimeExecutionHostId(environment.id)
      ownRepo(base.store, hostId)
      base.store.setWorkspaceSession(retiringSession(), hostId)
      const controller = controllerFor(base.store)
      let rejectFlush
      vi.spyOn(base.store, 'flushPendingOrThrowAsync').mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectFlush = reject
        })
      )
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const recovery = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
        () => base.store,
        () => {
          throw new Error('No database access expected')
        },
        (id) => controller.tryGetHostId(id)
      )
      const work = recovery.persist([{ candidate: recoveryCandidate(), resolution }])
      base.store.removeProjectForHost('repo-a', hostId)
      unpair(base, environment)
      isolateAbsentPartitionBeforeFix(base.store, hostId)
      rejectFlush(new Error('Controlled asynchronous persistence failure'))
      await expect(work).resolves.toEqual(new Set())
      const recreated = base.store.getWorkspaceSessionHostIds().includes(hostId)
      metrics[`recovery-${resolution}`] = { recreated, beforeUsesSimulatedDeletion: !fixed }
      expect(recreated).toBe(resolution === 'exited' && !rollbackGuard)
    }
  )

  it.each(['local', 'ssh:direct-target', 'runtime:historical-self-stamp'])(
    'preserves existing adopted rollback for %s',
    async (hostId) => {
      const base = fixture()
      ownRepo(base.store, hostId)
      base.store.setWorkspaceSession(retiringSession(), hostId)
      const controller = controllerFor(base.store)
      vi.spyOn(base.store, 'flushPendingOrThrowAsync').mockRejectedValue(
        new Error('Controlled persistence failure')
      )
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const recovery = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
        () => base.store,
        () => {
          throw new Error('No database access expected')
        },
        (id) => controller.tryGetHostId(id)
      )
      await expect(
        recovery.persist([{ candidate: recoveryCandidate(), resolution: 'adopted' }])
      ).resolves.toEqual(new Set())
      expect(
        base.store.getWorkspaceSession(hostId).sleepingAgentSessionsByPaneKey[PANE].prompt
      ).toBe('continue')
    }
  )

  it('records the legacy sync receipt when new-partition authority is unreadable', async () => {
    const base = fixture()
    const environment = pair(base.dir, 'unreadable')
    const hostId = toRuntimeExecutionHostId(environment.id)
    const knownHost = 'runtime:known-existing'
    base.store.setWorkspaceSession(session('known'), knownHost)
    base.store.setWorkspaceSession(session('local'))
    writeFileSync(getEnvironmentStorePath(base.dir), '{broken')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const receipt = await invokeWrite('session:set-sync', session('unknown'), hostId)
    expect(receipt).toBe(!fixed)
    const knownReceipt = await invokeWrite('session:set-sync', session('known-after'), knownHost)
    expect(knownReceipt).toBe(true)
    metrics.syncAuthorityFailure = {
      receipt,
      knownReceipt,
      created: base.store.getWorkspaceSessionHostIds().includes(hostId)
    }
    expect(metrics.syncAuthorityFailure.created).toBe(!fixed)
  })
})
