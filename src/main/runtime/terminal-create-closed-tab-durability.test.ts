import { captureSurfaceLayoutCommand } from '../workspace-surfaces/surface-layout-request'
import { emptySurfaceHostDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import { surfaceAdmissionRegistry } from '../workspace-surfaces/surface-admission-capture'
import type {
  SurfaceStorageResult,
  SurfaceStorageMutation
} from '../../shared/workspace-surfaces/surface-storage-command'
import { openWritableProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { WorkspaceSurfaceCommands } from '../persistence/loading-store/workspace-surface-commands'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import { hasClosedTerminalTabRecord } from '../../shared/workspace-layout/closed-terminal-tab-tombstones'
import type { ExecutionHostId } from '../../shared/execution-host'
import { profileStateDatabaseFile } from '../../shared/profile-state-storage-paths'

import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const createMethod = TERMINAL_LIFECYCLE_METHODS.find((method) => method.name === 'terminal.create')

async function persistedTab(hostId: ExecutionHostId, close = true) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-closed-create-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  const repo = {
    id: 'repo-1',
    path: directory,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  }
  store.addRepo(repo)
  const worktreeId = `${repo.id}::${repo.path}`
  const pane = { tabId: randomUUID(), leafId: randomUUID() }
  store.setWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: pane.tabId,
            ptyId: 'old-pty',
            worktreeId,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [pane.tabId]: {
          root: { type: 'leaf', leafId: pane.leafId },
          activeLeafId: pane.leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [pane.leafId]: 'old-pty' }
        }
      }
    },
    hostId
  )
  const runtime = new OrcaRuntimeService(store)
  if (close) {
    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId,
      target: { kind: 'tab', tabId: pane.tabId },
      reason: 'user'
    })
  }
  expect(
    hasClosedTerminalTabRecord(
      store.getWorkspaceSession(hostId).closedTerminalTabTombstonesByTabId,
      pane.tabId,
      worktreeId
    )
  ).toBe(close)
  await store.flushPendingOrThrowAsync()
  await store.freezeWritesAsync()
  const reloaded = createSqliteTestStore(Store, { dataFile })
  expect(
    hasClosedTerminalTabRecord(
      reloaded.getWorkspaceSession(hostId).closedTerminalTabTombstonesByTabId,
      pane.tabId,
      worktreeId
    )
  ).toBe(close)
  const restarted = new OrcaRuntimeService(reloaded)
  Object.assign(restarted, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: worktreeId,
      path: directory,
      connectionId: null,
      repo,
      folderWorkspace: null
    }))
  })
  const spawn = vi.fn(async () => ({ id: 'replacement-pty' }))
  const listProcesses = vi.fn(async () => [])
  restarted.setPtyController({
    spawn,
    listProcesses,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const create = (identity = pane) => {
    if (!createMethod) {
      throw new Error('terminal.create method missing')
    }
    return createMethod.handler(
      { worktree: `id:${worktreeId}`, ...identity },
      { runtime: restarted, pairedDeviceId: 'old-desktop', clientKind: 'runtime' }
    )
  }
  return { reloaded, worktreeId, pane, spawn, listProcesses, create }
}

describe('shipped terminal.create after a durable host close', () => {
  it.each(['local', 'runtime:legacy-host'] as const)(
    'refuses a stale id closed in %s before spawning, including after restart',
    async (hostId) => {
      const { reloaded, worktreeId, pane, spawn, listProcesses, create } =
        await persistedTab(hostId)
      await expect(create()).rejects.toThrow('tab_not_found')
      expect(spawn).not.toHaveBeenCalled()
      expect(listProcesses).not.toHaveBeenCalled()
      expect(reloaded.getWorkspaceSession().tabsByWorktree[worktreeId] ?? []).toEqual([])
      expect(
        reloaded.getWorkspaceSession(hostId).terminalLayoutsByTabId[pane.tabId]
      ).toBeUndefined()
    }
  )
})

describe('canonical finite close admission', () => {
  const ownedStores: Store[] = []
  afterEach(async () => {
    for (const store of ownedStores.splice(0)) {
      await store.freezeWritesAsync()
    }
  })

  async function fixture(nullTabId?: string) {
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
    const authority = new ProfileStateSqliteAuthority(databasePath, 'fence-experiment')
    const store = new Store({ dataFile, profileStateAuthority: authority })
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
    const create = (pane: { tabId: string; leafId: string }, currentRuntime = runtime) => {
      if (!createMethod) {
        throw new Error('terminal.create method missing')
      }
      return createMethod.handler(
        { worktree: `id:${worktreeId}`, ...pane },
        {
          runtime: currentRuntime,
          pairedDeviceId: 'old-desktop',
          clientKind: 'runtime'
        }
      )
    }
    const close = (tabId: string) =>
      runtime.closeTerminalSurfaceFromRenderer({
        worktreeId,
        target: { kind: 'tab', tabId },
        reason: 'user'
      })
    return {
      store,
      registry: surfaceAdmissionRegistry(store['runtime'].workspaceSurfaces!),
      authority,
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

  it('preserves captured logical absence through null normalization and unrelated workspace mutation, and replays its exact receipt', async () => {
    const pane = { tabId: randomUUID(), leafId: randomUUID() }
    const f = await fixture(pane.tabId)
    const reader = f.store['runtime'].workspaceSurfaces!
    expect(
      reader.read({ hostId: 'local', workspaceId: f.worktreeId, hostTabId: pane.tabId })
    ).toMatchObject({ content: null })
    const command = captureSurfaceLayoutCommand(reader, 'local', f.store.getWorkspaceSession(), {
      type: 'createTerminalTab',
      workspace: f.worktreeId,
      ...pane
    })
    expect(f.registry.size).toBe(1)
    await f.store.executeWorkspaceSurfaceCommand({
      type: 'replace',
      hostId: 'local',
      request: {
        hostId: 'local',
        workspaceId: 'unrelated::/workspace',
        hostTabId: 'unrelated',
        expected: null,
        content: null,
        callerId: 'normalize',
        commandId: randomUUID(),
        expiresAt: Date.now() + 600_000
      }
    })
    expect(f.store.readWorkspaceSurfaces()).toEqual([])
    const first = await f.store.executeWorkspaceSurfaceCommand(command)
    expect(first.outcome).toMatchObject({ status: 'accepted' })
    expect(f.registry.size).toBe(0)
    const replay = await f.store.executeWorkspaceSurfaceCommand(command)
    expect(replay.outcome).toEqual(first.outcome)
    expect(f.registry.size).toBe(0)
    expect(f.store.readWorkspaceSurfaces()).toHaveLength(1)
  })

  it('retains capture-time default-tab and cross-host raw-close refusal after bounded record eviction', async () => {
    const f = await fixture()
    const pane = { tabId: randomUUID(), leafId: randomUUID() }
    const remote = 'ssh:other-host'
    await f.store.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId: remote })
    await f.store.executeWorkspaceSurfaceCommand({
      type: 'replace',
      hostId: remote,
      request: {
        hostId: remote,
        workspaceId: f.worktreeId,
        hostTabId: pane.tabId,
        expected: null,
        content: null,
        callerId: 'remote-close',
        commandId: randomUUID(),
        expiresAt: Date.now() + 600_000
      }
    })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const execute = WorkspaceSurfaceCommands.prototype.executeWorkspaceSurfaceTransaction
    vi.spyOn(
      WorkspaceSurfaceCommands.prototype,
      'executeWorkspaceSurfaceTransaction'
    ).mockImplementationOnce(async function (this: WorkspaceSurfaceCommands, prepare, committed) {
      entered.resolve()
      await resume.promise
      return execute.call(this, prepare, committed)
    })
    const pending = f.store.applyLayoutCommand({
      type: 'applyDefaultTabs',
      workspace: f.worktreeId,
      tabs: [pane]
    })
    try {
      await entered.promise
      const before = Date.now()
      const clock = vi.spyOn(Date, 'now')
      try {
        for (let i = 1; i <= 500; i += 1) {
          clock.mockReturnValue(before + i)
          await f.store.executeWorkspaceSurfaceCommand({
            type: 'replace',
            hostId: remote,
            request: {
              hostId: remote,
              workspaceId: f.worktreeId,
              hostTabId: `new-${i}`,
              expected: null,
              content: null,
              callerId: 'evict',
              commandId: randomUUID(),
              expiresAt: Date.now() + 600_000
            }
          })
        }
      } finally {
        clock.mockRestore()
      }
      expect(
        f.store.getWorkspaceSession(remote).closedTerminalTabTombstonesByTabId?.[pane.tabId]
      ).toBeUndefined()
      resume.resolve()
      expect(await pending).toMatchObject({ ok: false, code: 'tab_not_found' })
      expect(f.registry.size).toBe(0)
      expect(f.store.readWorkspaceSurfaces()).toEqual([])
    } finally {
      resume.resolve()
      await Promise.allSettled([pending])
    }
  })

  it('co-writes bounded close evidence before old-peer capture, protects it from stale saves, and preserves it on reopen', async () => {
    const f = await fixture()
    const pane = { tabId: randomUUID(), leafId: randomUUID() }
    const live = { tabId: randomUUID(), leafId: randomUUID() }
    await f.create(live)
    const stale = structuredClone(f.store.getWorkspaceSession())
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const resolver = f.runtime.resolveTerminalWorkspaceLaunchScope.bind(f.runtime)
    vi.spyOn(f.runtime, 'resolveTerminalWorkspaceLaunchScope').mockImplementationOnce(
      async (...args) => {
        entered()
        await held
        return resolver(...args)
      }
    )
    const pending = f.create(pane).then(
      () => 'accepted',
      (error: Error) => error.message
    )
    await reached
    await f.close(pane.tabId)
    expect(
      f.store.readWorkspaceSurfaces().some((surface) => surface.hostTabId === pane.tabId)
    ).toBe(false)
    expect(
      hasClosedTerminalTabRecord(
        f.store.getWorkspaceSession().closedTerminalTabTombstonesByTabId,
        pane.tabId,
        f.worktreeId
      )
    ).toBe(true)
    f.store.setWorkspaceSession(stale)
    await f.store.flushPendingOrThrowAsync()
    expect(
      hasClosedTerminalTabRecord(
        f.store.getWorkspaceSession().closedTerminalTabTombstonesByTabId,
        pane.tabId,
        f.worktreeId
      )
    ).toBe(true)
    release()
    expect(await pending).toBe('tab_not_found')
    expect(f.spawn).toHaveBeenCalledTimes(1)
    await f.create({ tabId: randomUUID(), leafId: randomUUID() })
    await f.create(live)
    await f.store.freezeWritesAsync()
    const reloadedAuthority = new ProfileStateSqliteAuthority(
      profileStateDatabaseFile(f.directory),
      'fence-experiment'
    )
    const reloaded = new Store({ dataFile: f.dataFile, profileStateAuthority: reloadedAuthority })
    ownedStores.push(reloaded)
    const restarted = new OrcaRuntimeService(reloaded)
    Object.assign(restarted, { resolveTerminalWorkspaceLaunchScope: resolver })
    restarted.setPtyController({
      spawn: f.spawn,
      listProcesses: async () => [],
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await expect(f.create(pane, restarted)).rejects.toThrow('tab_not_found')
  })

  it('fences a capture during a held close commit through observer failure and bounded record eviction', async () => {
    const f = await fixture()
    const pane = { tabId: randomUUID(), leafId: randomUUID() }
    const closeCommitted = Promise.withResolvers<void>()
    const publishClose = Promise.withResolvers<void>()
    type Boundary = {
      executeSurfaceTransaction(
        commands: readonly SurfaceStorageMutation[]
      ): SurfaceStorageResult[] | Promise<SurfaceStorageResult[]>
    }
    const boundary: Boundary = f.authority
    const executeCommands = boundary.executeSurfaceTransaction.bind(boundary)
    vi.spyOn(boundary, 'executeSurfaceTransaction').mockImplementationOnce(async (commands) => {
      const result = await executeCommands(commands)
      closeCommitted.resolve()
      await publishClose.promise
      return result
    })
    const closing = f.close(pane.tabId)
    const closeFailure = expect(closing).rejects.toThrow('Committed surface publication failed')
    await closeCommitted.promise
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const execute = WorkspaceSurfaceCommands.prototype.executeWorkspaceSurfaceTransaction
    let captured: readonly SurfaceStorageMutation[] = []
    vi.spyOn(
      WorkspaceSurfaceCommands.prototype,
      'executeWorkspaceSurfaceTransaction'
    ).mockImplementationOnce(async function (this: WorkspaceSurfaceCommands, prepare, committed) {
      entered()
      await held
      return execute.call(
        this,
        () => {
          captured = prepare()
          return captured
        },
        committed
      )
    })
    const pending = f.create(pane).then(
      () => 'accepted',
      (error: Error) => error.message
    )
    try {
      await reached
      expect(f.registry.size).toBe(2)
      const stopFailingObserver = f.store.onWorkspaceSessionWritten(() => {
        throw new Error('observer failure')
      })
      publishClose.resolve()
      await closeFailure
      stopFailingObserver()
      const before = Date.now()
      const clock = vi.spyOn(Date, 'now')
      for (let i = 1; i <= 500; i += 1) {
        clock.mockReturnValue(before + i)
        await f.close(`newer-${i}`)
      }
      clock.mockRestore()
      const records = f.store.getWorkspaceSession().closedTerminalTabTombstonesByTabId!
      expect(Object.keys(records)).toHaveLength(500)
      expect(records[pane.tabId]).toBeUndefined()
      expect(f.store.readWorkspaceSurfaces()).toEqual([])
      expect(f.registry.size).toBe(1)
      release()
      expect(await pending).toBe('tab_not_found')
      const request = captured[0]
      expect(request?.type).toBe('layout')
      if (request?.type !== 'layout') {
        throw new Error('Expected captured layout')
      }
      expect(request.request.targets).toEqual(
        expect.arrayContaining([expect.objectContaining({ expected: null })])
      )
      expect(request.request.expiresAt).toBeGreaterThan(Date.now())
      expect(f.spawn).not.toHaveBeenCalled()
      expect(f.registry.size).toBe(0)
      // A fresh invocation follows the existing cap policy; the suspended predecessor never rebases.
      await expect(f.create(pane)).resolves.toHaveProperty('terminal.ptyId')
      expect(f.spawn).toHaveBeenCalledTimes(1)
    } finally {
      publishClose.resolve()
      release()
      await Promise.allSettled([closeFailure, pending])
    }
  })
  it('keeps a captured absence usable after a rolled-back close and fences an old Store callback after finalization', async () => {
    const f = await fixture()
    const pane = { tabId: randomUUID(), leafId: randomUUID() }
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const execute = WorkspaceSurfaceCommands.prototype.executeWorkspaceSurfaceTransaction
    vi.spyOn(
      WorkspaceSurfaceCommands.prototype,
      'executeWorkspaceSurfaceTransaction'
    ).mockImplementationOnce(async function (this: WorkspaceSurfaceCommands, prepare, committed) {
      entered.resolve()
      await resume.promise
      return execute.call(this, prepare, committed)
    })
    const pending = f.create(pane)
    await entered.promise
    const opened = openWritableProfileStateDatabase(
      profileStateDatabaseFile(f.directory),
      'fence-experiment'
    )
    opened.db.exec(
      `CREATE TRIGGER refuse_close BEFORE INSERT ON workspace_surfaces WHEN NEW.host_tab_id = '${pane.tabId}' BEGIN SELECT RAISE(ABORT, 'close rejected'); END`
    )
    try {
      await expect(f.close(pane.tabId)).rejects.toThrow('close rejected')
    } finally {
      opened.db.exec('DROP TRIGGER refuse_close')
      opened.db.close()
    }
    expect(
      f.store.getWorkspaceSession().closedTerminalTabTombstonesByTabId?.[pane.tabId]
    ).toBeUndefined()
    expect(f.registry.size).toBe(1)
    resume.resolve()
    await expect(pending).resolves.toHaveProperty('terminal.ptyId')
    expect(f.registry.size).toBe(0)
    const lateEntered = Promise.withResolvers<void>()
    const lateResume = Promise.withResolvers<void>()
    vi.spyOn(
      WorkspaceSurfaceCommands.prototype,
      'executeWorkspaceSurfaceTransaction'
    ).mockImplementationOnce(async function (this: WorkspaceSurfaceCommands, prepare, committed) {
      lateEntered.resolve()
      await lateResume.promise
      return execute.call(this, prepare, committed)
    })
    const late = f.create({ tabId: randomUUID(), leafId: randomUUID() })
    const rejected = expect(late).rejects.toThrow('finalized profile persistence')
    await lateEntered.promise
    expect(f.registry.size).toBe(1)
    await f.store.freezeWritesAsync()
    lateResume.resolve()
    await rejected
    expect(f.registry.size).toBe(0)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
})
