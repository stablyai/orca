import {
  createCanonicalSurfaceRuntimeFixture,
  installPhysicalController,
  openPairedClientBrowserPage,
  createTerminalSurfaceByRpc
} from './terminal-surface-controller-test-fixture'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { captureSurfaceLayoutCommand } from '../workspace-surfaces/surface-layout-request'
import type {
  SurfaceStorageResult,
  SurfaceStorageMutation
} from '../../shared/workspace-surfaces/surface-storage-command'
import { openWritableProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { WorkspaceSurfaceCommands } from '../persistence/loading-store/workspace-surface-commands'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { hasClosedTerminalTabRecord } from '../../shared/workspace-layout/closed-terminal-tab-tombstones'
import type { ExecutionHostId } from '../../shared/execution-host'
import { profileStateDatabaseFile } from '../../shared/profile-state-storage-paths'

import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

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
  const create = (identity = pane) => createTerminalSurfaceByRpc(restarted, worktreeId, identity)
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

  const fixture = (nullTabId?: string) =>
    createCanonicalSurfaceRuntimeFixture(directories, ownedStores, nullTabId)

  it('keeps canonical headless create, split, move and close in the saved groups with the rollout off', async () => {
    const f = await fixture()
    const { processes, reuseNextId } = installPhysicalController(f)
    f.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const selector = `id:${f.worktreeId}`
    const firstCreated = await f.runtime.createMobileSessionTerminal(selector, { activate: false })
    const first = { tabId: firstCreated.tab.parentTabId, leafId: firstCreated.tab.leafId }
    const second = { tabId: randomUUID(), leafId: randomUUID() }
    await f.create(second)
    const listed = await f.runtime.listMobileSessionTabs(selector)
    const savedGroups = () => f.store.getWorkspaceSession().tabGroups?.[f.worktreeId] ?? []
    expect(listed.tabGroups?.map((group) => ({ id: group.id, tabs: group.tabOrder }))).toEqual(
      savedGroups().map((group) => ({ id: group.id, tabs: group.tabOrder }))
    )
    expect(listed.tabGroups?.flatMap((group) => group.tabOrder)).toEqual([
      first.tabId,
      second.tabId
    ])
    const originalGroup = listed.tabGroups![0]!.id
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'split',
      tabId: second.tabId,
      targetGroupId: originalGroup,
      splitDirection: 'right'
    })
    const right = savedGroups().find((group) => group.id !== originalGroup)!.id
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'move-to-group',
      tabId: first.tabId,
      targetGroupId: right,
      index: 0
    })
    const moved = await f.runtime.listMobileSessionTabs(selector)
    expect(moved.tabGroups?.find((group) => group.id === right)?.tabOrder).toEqual([
      first.tabId,
      second.tabId
    ])
    expect(savedGroups().find((group) => group.id === right)?.tabOrder).toEqual([
      first.tabId,
      second.tabId
    ])
    const firstTerminal = (await f.runtime.listTerminals(selector)).terminals.find(
      (row) => row.tabId === first.tabId
    )!
    const split = await f.runtime.splitTerminal(firstTerminal.handle, { direction: 'horizontal' })
    const splitResource = (await f.runtime.listTerminals(selector)).terminals.find(
      (row) => row.leafId === split.leafId
    )!.ptyId
    await f.runtime.closeMobileSessionTab(selector, `${first.tabId}::${split.leafId}`, {
      reason: 'user'
    })
    expect(await f.runtime.readTerminal(firstTerminal.handle)).toMatchObject({ status: 'running' })
    expect(processes.has(splitResource!)).toBe(false)
    const committed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const apply = f.runtime.applyLayoutCommand.bind(f.runtime)
    const held = vi.spyOn(f.runtime, 'applyLayoutCommand').mockImplementation(async (...args) => {
      const reply = await apply(...args)
      if (args[0].type === 'closeTabs') {
        committed.resolve()
        await release.promise
      }
      return reply
    })
    const closing = f.runtime.closeMobileSessionTab(selector, second.tabId, { reason: 'user' })
    await committed.promise
    expect(
      f.store.getWorkspaceSession().tabsByWorktree[f.worktreeId]?.map((row) => row.id)
    ).toEqual([first.tabId])
    release.resolve()
    await closing
    held.mockRestore()
    const closed = await f.runtime.listMobileSessionTabs(selector)
    expect(
      closed.tabs.filter((row) => row.type === 'terminal').map((row) => row.parentTabId)
    ).toEqual([first.tabId])
    expect(savedGroups().flatMap((group) => group.tabOrder)).toEqual([first.tabId])
    expect([...processes.keys()]).toEqual([
      f.store.getWorkspaceSession().terminalLayoutsByTabId[first.tabId]!.ptyIdsByLeafId![
        first.leafId
      ]
    ])
    const terminal = (await f.runtime.listTerminals(selector)).terminals.find(
      (row) => row.tabId === first.tabId
    )!
    const oldCommitted = Promise.withResolvers<void>()
    const resumeOldClose = Promise.withResolvers<void>()
    const replacing = vi
      .spyOn(f.runtime, 'applyLayoutCommand')
      .mockImplementation(async (...args) => {
        const reply = await apply(...args)
        if (args[0].type === 'closeTabs') {
          oldCommitted.resolve()
          await resumeOldClose.promise
        }
        return reply
      })
    const oldClose = f.runtime.closeTerminal(terminal.handle)
    await oldCommitted.promise
    const successor = { tabId: randomUUID(), leafId: randomUUID() }
    reuseNextId(terminal.ptyId!)
    await f.create(successor)
    const successorTerminal = (await f.runtime.listTerminals(selector)).terminals.find(
      (row) => row.tabId === successor.tabId
    )!
    resumeOldClose.resolve()
    expect(await oldClose).toMatchObject({ tabId: first.tabId, ptyKilled: false })
    replacing.mockRestore()
    expect(await f.runtime.readTerminal(successorTerminal.handle)).toMatchObject({
      status: 'running'
    })
    expect(processes.has(successorTerminal.ptyId!)).toBe(true)
    expect(
      (await f.runtime.listMobileSessionTabs(selector)).tabs.flatMap((row) =>
        row.type === 'terminal' ? [row.parentTabId] : []
      )
    ).toEqual([successor.tabId])
    expect(await f.runtime.closeTerminal(successorTerminal.handle)).toMatchObject({
      ptyKilled: true
    })
    expect(
      (await f.runtime.listMobileSessionTabs(selector)).tabs.filter(
        (row) => row.type === 'terminal'
      )
    ).toEqual([])
    expect(savedGroups().flatMap((group) => group.tabOrder)).toEqual([])
    expect([...processes.values()]).toEqual([])
  })

  it('keeps a background client browser page movable and split after rebuilding canonical headless rows', async () => {
    const f = await fixture()
    const selector = `id:${f.worktreeId}`
    installPhysicalController(f)
    f.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await f.runtime.createMobileSessionTerminal(selector, { activate: false })
    const browser = await openPairedClientBrowserPage(f.runtime, f.worktreeId)
    expect(
      f.store.getWorkspaceSession().clientHostedBrowserPagesByWorktree?.[f.worktreeId]
    ).toEqual([expect.objectContaining({ browserPageId: browser.browserPageId })])
    const listed = await f.runtime.listMobileSessionTabs(selector)
    expect(listed.tabs.find((row) => row.id === browser.browserPageId)).toMatchObject({
      type: 'browser',
      isActive: false
    })
    const groupId = listed.tabGroups!.find((group) =>
      group.tabOrder.includes(browser.browserPageId)
    )!.id
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'split',
      tabId: browser.browserPageId,
      targetGroupId: groupId,
      splitDirection: 'right'
    })
    const moved = await f.runtime.listMobileSessionTabs(selector)
    const browserGroup = moved.tabGroups!.find((group) =>
      group.tabOrder.includes(browser.browserPageId)
    )!
    expect(browserGroup.id).not.toBe(groupId)
    expect(browserGroup.tabOrder).toEqual([browser.browserPageId])
    expect(
      f.store
        .getWorkspaceSession()
        .tabGroups?.[f.worktreeId]?.find((group) => group.id === browserGroup.id)?.tabOrder
    ).toEqual([browser.browserPageId])
    const terminalId = listed.tabs.find((row) => row.type === 'terminal')!.parentTabId
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'move-to-group',
      tabId: terminalId,
      targetGroupId: browserGroup.id,
      index: 0
    })
    expect(
      (await f.runtime.listMobileSessionTabs(selector)).tabGroups?.find(
        (group) => group.id === browserGroup.id
      )?.tabOrder
    ).toEqual([terminalId, browser.browserPageId])
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'split',
      tabId: terminalId,
      targetGroupId: browserGroup.id,
      splitDirection: 'right'
    })
    const split = await f.runtime.listMobileSessionTabs(selector)
    const terminalGroup = split.tabGroups!.find((group) => group.tabOrder.includes(terminalId))!
    expect(terminalGroup.id).not.toBe(browserGroup.id)
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'move-to-group',
      tabId: browser.browserPageId,
      targetGroupId: terminalGroup.id,
      index: 0
    })
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'reorder',
      tabId: terminalId,
      targetGroupId: terminalGroup.id,
      tabOrder: [terminalId, browser.browserPageId]
    })
    const combined = await f.runtime.listMobileSessionTabs(selector)
    expect(combined.tabGroups?.find((group) => group.id === terminalGroup.id)?.tabOrder).toEqual([
      terminalId,
      browser.browserPageId
    ])
    expect(
      f.store
        .getWorkspaceSession()
        .tabGroups?.[f.worktreeId]?.find((group) => group.id === terminalGroup.id)?.tabOrder
    ).toEqual([terminalId, browser.browserPageId])
    await f.store.flushPendingOrThrowAsync()
    await f.store.freezeWritesAsync()
    const reopened = new Store({
      dataFile: f.dataFile,
      profileStateAuthority: new ProfileStateSqliteAuthority(
        profileStateDatabaseFile(f.directory),
        'fence-experiment'
      )
    })
    ownedStores.push(reopened)
    expect(reopened.readWorkspaceSurfaces().map((surface) => surface.hostTabId)).toEqual([
      terminalId
    ])
    const restarted = new OrcaRuntimeService(reopened)
    restarted.rehydrateClientHostedBrowserPages()
    restarted.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const rebuilt = await restarted.listMobileSessionTabs(selector)
    expect(rebuilt.tabGroups?.find((group) => group.id === terminalGroup.id)?.tabOrder).toEqual([
      terminalId,
      browser.browserPageId
    ])
    expect(rebuilt.tabGroupLayout).toEqual(combined.tabGroupLayout)
  })

  it('keeps background placement and a requested paired browser group through publication and disk reopen', async () => {
    const f = await fixture()
    const selector = `id:${f.worktreeId}`
    installPhysicalController(f)
    f.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const first = await f.runtime.createMobileSessionTerminal(selector, { activate: false })
    const foreground = await f.runtime.createMobileSessionTerminal(selector, { activate: true })
    const beforeSplit = await f.runtime.listMobileSessionTabs(selector)
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'split',
      tabId: foreground.tab.parentTabId,
      targetGroupId: beforeSplit.tabGroups![0]!.id,
      splitDirection: 'right'
    })
    const beforeBrowser = await f.runtime.listMobileSessionTabs(selector)
    const firstGroup = beforeBrowser.tabGroups![0]!.id
    const targetGroup = beforeBrowser.tabGroups![1]!.id
    expect(beforeBrowser.activeGroupId).toBe(targetGroup)
    const background = await openPairedClientBrowserPage(f.runtime, f.worktreeId)
    const backgroundSnapshot = await f.runtime.listMobileSessionTabs(selector)
    expect(
      backgroundSnapshot.tabGroups?.find((group) =>
        group.tabOrder.includes(background.browserPageId)
      )?.id
    ).toBe(firstGroup)
    const terminalId = first.tab.parentTabId
    expect(
      backgroundSnapshot.tabGroups!.find((group) => group.id === firstGroup)?.tabOrder
    ).toEqual([terminalId, background.browserPageId])
    await f.runtime.moveMobileSessionTab(selector, {
      kind: 'reorder',
      tabId: terminalId,
      targetGroupId: firstGroup,
      tabOrder: [background.browserPageId, terminalId]
    })
    expect(
      (await f.runtime.listMobileSessionTabs(selector)).tabGroups?.find(
        (group) => group.id === firstGroup
      )?.tabOrder
    ).toEqual([background.browserPageId, terminalId])
    expect(
      f.store
        .getWorkspaceSession()
        .tabGroups?.[f.worktreeId]?.find((group) => group.id === firstGroup)?.tabOrder
    ).toEqual([background.browserPageId, terminalId])
    const selected = await openPairedClientBrowserPage(f.runtime, f.worktreeId, {
      activate: true,
      targetGroupId: targetGroup
    })
    const listed = await f.runtime.listMobileSessionTabs(selector)
    expect(
      listed.tabGroups?.find((group) => group.tabOrder.includes(selected.browserPageId))?.id
    ).toBe(targetGroup)
    expect(
      f.store
        .getWorkspaceSession()
        .tabGroups?.[f.worktreeId]?.find((group) => group.tabOrder.includes(selected.browserPageId))
        ?.id
    ).toBe(targetGroup)
    await f.store.flushPendingOrThrowAsync()
    await f.store.freezeWritesAsync()
    const reopened = new Store({
      dataFile: f.dataFile,
      profileStateAuthority: new ProfileStateSqliteAuthority(
        profileStateDatabaseFile(f.directory),
        'fence-experiment'
      )
    })
    ownedStores.push(reopened)
    const restarted = new OrcaRuntimeService(reopened)
    restarted.rehydrateClientHostedBrowserPages()
    restarted.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const rebuilt = await restarted.listMobileSessionTabs(selector)
    expect(
      rebuilt.tabGroups?.find((group) => group.tabOrder.includes(selected.browserPageId))?.id
    ).toBe(targetGroup)
    expect(rebuilt.tabGroups?.find((group) => group.id === firstGroup)?.tabOrder).toEqual([
      background.browserPageId,
      terminalId
    ])
  })

  it('preserves captured logical absence after startup normalizes null content and unrelated workspace mutation, and replays its exact receipt', async () => {
    const pane = { tabId: randomUUID(), leafId: randomUUID() }
    const f = await fixture(pane.tabId)
    const reader = f.store['runtime'].workspaceSurfaces!
    expect(f.store.readWorkspaceSurfaces()).toEqual([])
    const command = captureSurfaceLayoutCommand(reader, 'local', f.store.getWorkspaceSession(), {
      type: 'createTerminalTab',
      workspace: f.worktreeId,
      ...pane
    })
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
    const replay = await f.store.executeWorkspaceSurfaceCommand(command)
    expect(replay.outcome).toEqual(first.outcome)
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
        clock.mockReturnValue(before + 500)
        await f.store.executeWorkspaceSurfaceTransaction(() =>
          Array.from({ length: 500 }, (_, i) => ({
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
          }))
        )
      } finally {
        clock.mockRestore()
      }
      expect(
        f.store.getWorkspaceSession(remote).closedTerminalTabTombstonesByTabId?.[pane.tabId]
      ).toBeUndefined()
      resume.resolve()
      expect(await pending).toMatchObject({ ok: false, code: 'tab_not_found' })
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
    resume.resolve()
    await expect(pending).resolves.toHaveProperty('terminal.ptyId')
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
    await f.store.freezeWritesAsync()
    lateResume.resolve()
    await rejected
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
})
