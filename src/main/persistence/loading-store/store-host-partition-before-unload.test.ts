import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'
import { splitWorkspaceSessionByHost } from '../../../renderer/src/lib/workspace-session-host-split'
import {
  closeTestStores,
  createSqliteTestStore,
  makeTerminalTab,
  readPersistedStateJson
} from '../../persistence-test-harness'

type ShutdownStageArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

const { syncHandlers, invokeHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<
    string,
    (event: { returnValue?: unknown }, args: ShutdownStageArgs) => void
  >(),
  invokeHandlers: new Map<string, () => Promise<{ ok: boolean }>>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    on: (
      channel: string,
      handler: (event: { returnValue?: unknown }, args: ShutdownStageArgs) => void
    ) => syncHandlers.set(channel, handler),
    handle: (channel: string, handler: () => Promise<{ ok: boolean }>) =>
      invokeHandlers.set(channel, handler)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')
const { registerRendererShutdownCheckpointHandler } =
  await import('../../ipc/renderer-shutdown-checkpoint')

const HOST_ID = 'runtime:env-1'
const WORKTREE = `repo-1::${join(tmpdir(), 'worktree-a')}`
const LOCAL_WORKTREE = `repo-local::${join(tmpdir(), 'worktree-local')}`
const TAB_ID = 'host-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const stores: InstanceType<typeof Store>[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
  syncHandlers.clear()
  invokeHandlers.clear()
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  return store
}

function dataFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-host-before-unload-')))
  return join(dir, 'orca-data.json')
}

function editorOnlyHostSlice(
  worktreeId = WORKTREE,
  hostId: ExecutionHostId = HOST_ID
): WorkspaceSessionState {
  const slices = splitWorkspaceSessionByHost(
    {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [worktreeId]: [
          {
            worktreeId,
            filePath: join(tmpdir(), 'file.ts'),
            relativePath: 'file.ts',
            language: 'typescript'
          }
        ]
      }
    },
    (id) => (id === worktreeId ? hostId : 'local')
  )
  const slice = slices[hostId]
  if (!slice) {
    throw new Error('Expected the renderer to produce an editor-only host slice')
  }
  expect(Object.hasOwn(slice, 'tabsByWorktree')).toBe(false)
  expect(Object.hasOwn(slice, 'terminalLayoutsByTabId')).toBe(false)
  return slice
}

async function stageShutdown(
  store: InstanceType<typeof Store>,
  sessions: ShutdownStageArgs['sessions']
): Promise<void> {
  registerRendererShutdownCheckpointHandler(store)
  const event: { returnValue?: unknown } = {}
  const stage = syncHandlers.get('app:stage-before-unload-sync')
  const awaitCheckpoint = invokeHandlers.get('app:await-before-unload-checkpoint')
  if (!stage || !awaitCheckpoint) {
    throw new Error('Shutdown checkpoint IPC handlers were not registered')
  }
  stage(event, { sessions, ui: { activeView: 'terminal' } })
  expect(event.returnValue).toEqual({ ok: true })
  await expect(awaitCheckpoint()).resolves.toEqual({ ok: true })
}

describe('before-unload checkpoint with an editor-only paired host', () => {
  it('stages and durably saves a host slice with no terminal maps and an empty topology revision map', async () => {
    const path = dataFile()
    const store = openStore(path)
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), terminalTopologyRevisionByRepoId: {} },
      HOST_ID
    )

    await stageShutdown(store, [{ state: editorOnlyHostSlice(), hostId: HOST_ID }])

    const persisted: unknown = JSON.parse(readPersistedStateJson(path))
    if (
      !isWorkspaceSessionRecord(persisted) ||
      !isWorkspaceSessionRecord(persisted.workspaceSessionsByHostId) ||
      !isWorkspaceSessionRecord(persisted.workspaceSessionsByHostId[HOST_ID])
    ) {
      throw new Error('Expected the paired host partition in the persisted profile')
    }
    const host = persisted.workspaceSessionsByHostId[HOST_ID]
    expect(host.tabsByWorktree).toEqual({})
    expect(host.terminalLayoutsByTabId).toEqual({})
    expect(openStore(path).getWorkspaceSession(HOST_ID).openFilesByWorktree).toEqual({
      [WORKTREE]: [expect.objectContaining({ relativePath: 'file.ts' })]
    })
  })
  it.each([undefined, {}])(
    'accepts an older partition missing required maps with revisions %j',
    async (revisions) => {
      const store = openStore(dataFile())
      store.setWorkspaceSession(
        { ...getDefaultWorkspaceSession(), terminalTopologyRevisionByRepoId: revisions },
        HOST_ID
      )
      const persisted = store.getWorkspaceSession(HOST_ID)
      Reflect.deleteProperty(persisted, 'tabsByWorktree')
      Reflect.deleteProperty(persisted, 'terminalLayoutsByTabId')

      await stageShutdown(store, [{ state: editorOnlyHostSlice(), hostId: HOST_ID }])

      expect(store.getWorkspaceSession(HOST_ID).tabsByWorktree).toEqual({})
      expect(store.getWorkspaceSession(HOST_ID).terminalLayoutsByTabId).toEqual({})
    }
  )

  it.each([HOST_ID, 'ssh:target-1'] as const)(
    'keeps authoritative live tabs and bindings in %s without changing another host',
    async (hostId) => {
      const store = openStore(dataFile())
      const localTab = makeTerminalTab({ id: 'local-tab', worktreeId: LOCAL_WORKTREE })
      store.setWorkspaceSession({
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [LOCAL_WORKTREE]: [localTab] }
      })
      const localBefore = structuredClone(store.getWorkspaceSession())
      const tab = makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE, ptyId: 'live-pty' })
      const layout = {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'live-pty' }
      } as const
      store.setWorkspaceSession(
        {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { [WORKTREE]: [tab] },
          terminalLayoutsByTabId: { [TAB_ID]: layout },
          terminalTopologyRevisionByRepoId: { 'repo-1': 1 },
          terminalPtyIncarnationsByPaneKey: { [`${TAB_ID}:${LEAF_ID}`]: 'live-incarnation' }
        },
        hostId
      )
      store.upsertSshRemotePtyLease({
        targetId: 'target-1',
        ptyId: 'live-pty',
        worktreeId: WORKTREE,
        tabId: TAB_ID,
        leafId: LEAF_ID,
        state: 'attached'
      })
      const leasesBefore = structuredClone(store.getSshRemotePtyLeases())

      await stageShutdown(store, [{ state: editorOnlyHostSlice(WORKTREE, hostId), hostId }])

      expect(store.getWorkspaceSession(hostId)).toMatchObject({
        tabsByWorktree: { [WORKTREE]: [tab] },
        terminalLayoutsByTabId: { [TAB_ID]: layout },
        terminalTopologyRevisionByRepoId: { 'repo-1': 1 }
      })
      expect(store.getWorkspaceSession()).toEqual(localBefore)
      expect(store.getSshRemotePtyLeases()).toEqual(leasesBefore)
    }
  )

  it('continues retiring legacy tombstones before rebasing a slice that omits terminal maps', async () => {
    const store = openStore(dataFile())
    store.setWorkspaceSession(getDefaultWorkspaceSession(), HOST_ID)
    const slice = editorOnlyHostSlice()
    slice.terminalSurfaceTombstonesByPaneKey = {
      [`${TAB_ID}:${LEAF_ID}`]: {
        worktreeId: WORKTREE,
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId: 'retired-pty',
        incarnationId: 'retired-incarnation',
        retiredAt: 1
      }
    }

    await stageShutdown(store, [{ state: slice, hostId: HOST_ID }])

    const session = store.getWorkspaceSession(HOST_ID)
    expect(session.tabsByWorktree).toEqual({})
    expect(session.terminalLayoutsByTabId).toEqual({})
    expect(session.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(session.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 1 })
  })

  it('does not revive a closed terminal when an old snapshot is staged', async () => {
    const store = openStore(dataFile())
    const stale = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE })] }
    }
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), terminalTopologyRevisionByRepoId: { 'repo-1': 2 } },
      HOST_ID
    )

    await stageShutdown(store, [{ state: stale, hostId: HOST_ID }])
    await stageShutdown(store, [{ state: editorOnlyHostSlice(), hostId: HOST_ID }])

    const session = store.getWorkspaceSession(HOST_ID)
    expect(session.tabsByWorktree).toEqual({ [WORKTREE]: [] })
    expect(session.terminalLayoutsByTabId).toEqual({})
    expect(session.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 2 })
  })

  it('preserves an unfenced terminal close through the ordinary host writer', () => {
    const store = openStore(dataFile())
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [WORKTREE]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE })] }
      },
      HOST_ID
    )

    store.setWorkspaceSession(editorOnlyHostSlice(), HOST_ID)

    expect(store.getWorkspaceSession(HOST_ID).tabsByWorktree).toEqual({})
  })

  it('accepts an editor-only folder workspace host slice', async () => {
    const store = openStore(dataFile())
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), terminalTopologyRevisionByRepoId: {} },
      HOST_ID
    )

    await stageShutdown(store, [{ state: editorOnlyHostSlice('folder:folder-1'), hostId: HOST_ID }])

    expect(
      store.getWorkspaceSession(HOST_ID).openFilesByWorktree?.['folder:folder-1']
    ).toHaveLength(1)
  })
})
