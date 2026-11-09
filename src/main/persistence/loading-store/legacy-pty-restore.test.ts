import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deferred } from './profile-state-delayed-authority-fixture'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { Store } from './store'
import { HistoryManager } from '../../daemon/history/storage/history-manager'
import { HistoryReader } from '../../daemon/history/restoration/history-reader'
import { getDaemonHistoryDir } from '../../daemon/launch/daemon-launch-paths'
import { legacyPanePtySessionId } from '../../daemon/sessions/pty-session-id'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../../daemon/launch/daemon-generation-liveness', () => ({
  listLiveDaemonProtocols: async () => []
}))
vi.mock('../../ipc/pty/host-env/assembly', () => ({
  buildPtyHostEnv: async (_id: string, env: Record<string, string> | undefined) => ({ ...env })
}))

import {
  restoreFixture,
  workspace,
  tabId,
  leafId,
  paneKey
} from './legacy-pty-restore-test-fixture'
import { installedRestore } from './legacy-pty-runtime-restore-test-fixture'
describe('legacy terminal restore acquisition', () => {
  it('restores a saved row through the installed runtime controller and displays its old screen', async () => {
    const f = await restoreFixture()
    const { runtime, create } = installedRestore(f)
    const created = await create()
    expect(created.ptyId).toMatch(/^repo-local::\/fixture\/local@@[a-f0-9]{8}$/)
    expect(f.seen).toEqual([
      { id: '9', attachOnly: true },
      { id: created.ptyId, attachOnly: false }
    ])
    expect(
      f.readState().workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
    ).toBe(created.ptyId)
    const screen = await runtime.serializeMainTerminalBuffer(created.ptyId!, {
      scrollbackRows: 100
    })
    expect(screen?.data).toContain('old terminal screen')
    await runtime.onPtyExit(created.ptyId!, 0, `incarnation-${created.ptyId}`, {
      providerExitObserved: true
    })
  })

  it('migrates after ordinary saves, rebases a stale window, and closes after main settlement while the window still knows 9', async () => {
    const f = await restoreFixture()
    f.store.patchWorkspaceSession({ activeTabId: tabId })
    f.store.updateOnboarding({})
    const before = readFileSync(join(f.profile, 'terminal-history/9/checkpoint.json'))
    const result = await f.start()
    expect(result.result.id).toMatch(/^repo-local::\/fixture\/local@@[a-f0-9]{8}$/)
    expect(result.result.coldRestore).toMatchObject({ cwd: '/fixture/local' })
    expect(
      readFileSync(
        join(f.profile, 'terminal-history', encodeURIComponent(result.result.id), 'checkpoint.json')
      )
    ).toEqual(before)
    expect(
      f.readState().workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
    ).toBe(result.result.id)
    f.store.setWorkspaceSession(f.legacySnapshot)
    expect(
      f.store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[leafId]
    ).toBe(result.result.id)
    expect(f.store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      `incarnation-${result.result.id}`
    )
    f.alive.add('9')
    await f.provider.shutdown('9')
    expect(f.alive.has(result.result.id)).toBe(true)
    expect(await f.close()).toBeUndefined()
    await vi.waitFor(() => expect(f.alive.has(result.result.id)).toBe(false))
    expect(
      existsSync(
        join(f.profile, 'terminal-history', encodeURIComponent(result.result.id), 'checkpoint.json')
      )
    ).toBe(true)
    expect(
      f.store.getWorkspaceSession().tabsByWorktree[workspace]?.some((row) => row.id === tabId)
    ).toBe(false)
  })

  it('leaves ordinary scoped terminals to their existing close owner', async () => {
    const f = await restoreFixture()
    const id = 'repo-local::/fixture/local@@0123abcd'
    f.alive.add(id)
    f.incarnations.set(id, 'ordinary-incarnation')
    await f.store.persistPtyBinding({
      worktreeId: workspace,
      tabId,
      leafId,
      ptyId: id,
      incarnationId: 'ordinary-incarnation',
      mayCreate: false
    })
    await f.close()
    expect(f.provider.killFenced).not.toHaveBeenCalled()
    expect(f.alive.has(id)).toBe(true)
    await f.provider.shutdown(id)
    expect(f.alive.has(id)).toBe(false)
  })

  it('selects committed canonical recovery before touching a newly reused 9 after a crash before binding', async () => {
    const f = await restoreFixture()
    await expect(f.start(true)).rejects.toThrow('crash before bind')
    const canonical = 'repo-local::/fixture/local@@e2fec859'
    expect(
      existsSync(join(f.profile, 'terminal-history', encodeURIComponent(canonical), 'meta.json'))
    ).toBe(true)
    f.alive.clear()
    f.alive.add('9')
    f.seen.length = 0
    const result = await f.start()
    expect(result.result.id).toBe(canonical)
    expect(f.seen.some((call) => call.id === '9')).toBe(false)
    expect(result.result.coldRestore).toMatchObject({ cwd: '/fixture/local' })
  })

  it('does not spawn either identity after an accepted close while the missing legacy probe is outstanding', async () => {
    const f = await restoreFixture()
    const probe = f.pauseProbe()
    const pending = f.start()
    const rejected = expect(pending).rejects.toThrow()
    await probe.started
    await f.close()
    probe.gate.resolve()
    await rejected
    expect(f.seen.filter((call) => !call.attachOnly)).toEqual([])
    expect(
      existsSync(
        join(
          f.profile,
          'terminal-history',
          encodeURIComponent(legacyPanePtySessionId(workspace, leafId, '9')),
          'meta.json'
        )
      )
    ).toBe(false)
    expect(readFileSync(join(f.profile, 'terminal-history/9/checkpoint.json'), 'utf8')).toContain(
      'old terminal screen'
    )
  })
})

it('cancels accepted snapshot removal before a selected physical result returns, retaining history', async () => {
  const f = await restoreFixture()
  const pause = f.pauseFresh()
  const pending = f.start()
  const rejected = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
  await pause.started
  f.removeSnapshot()
  pause.gate.resolve()
  await rejected
  const id = legacyPanePtySessionId(workspace, leafId, '9')
  expect(f.alive.has(id)).toBe(false)
  expect(
    existsSync(join(f.profile, 'terminal-history', encodeURIComponent(id), 'checkpoint.json'))
  ).toBe(true)
  expect(f.store.getWorkspaceSession().tabsByWorktree[workspace]).toEqual([])
})

it('keeps a replacement incarnation when a selected restore is closed before its reply', async () => {
  const f = await restoreFixture()
  const pause = f.pauseFresh()
  const pending = f.start()
  const rejected = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
  await pause.started
  await f.close()
  const id = legacyPanePtySessionId(workspace, leafId, '9')
  f.incarnations.set(id, 'replacement-incarnation')
  pause.gate.resolve()
  await rejected
  expect(f.alive.has(id)).toBe(true)
  expect(f.incarnations.get(id)).toBe('replacement-incarnation')
})

it('keeps the surviving numeric terminal in its original pane without relaunching it', async () => {
  const f = await restoreFixture()
  f.alive.add('9')
  const result = await f.start()
  expect(result.result.id).toBe('9')
  expect(result.result.isReattach).toBe(true)
  expect(f.seen.filter((call) => !call.attachOnly)).toEqual([])
  expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[leafId]).toBe(
    '9'
  )
})

it('retains today’s visible legacy history and numeric binding when two old panes both claim 9', async () => {
  const f = await restoreFixture()
  await f.addLegacyPeer()
  const result = await f.start()
  expect(result.result.id).toBe('9')
  expect(result.result.coldRestore).toMatchObject({
    scrollback: 'old terminal screen',
    cwd: '/fixture/local'
  })
  expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[leafId]).toBe(
    '9'
  )
  expect(
    f.store.getWorkspaceSession().terminalLayoutsByTabId['peer-tab'].ptyIdsByLeafId?.[
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ]
  ).toBe('9')
})

it.each(['layout close', 'unified-only removal'] as const)(
  'cancels a selected pending restore on admitted %s',
  async (entry) => {
    const f = await restoreFixture()
    const pause = f.pauseFresh()
    const pending = f.start()
    const rejected = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
    await pause.started
    if (entry === 'layout close') {
      const result = await f.store.applyLayoutCommand({
        type: 'closeTabs',
        workspace,
        tabIds: [tabId],
        force: true,
        recordClose: 'user'
      })
      expect(result.ok).toBe(true)
    } else {
      f.store.patchWorkspaceSession({
        unifiedTabs: { ...f.store.getWorkspaceSession().unifiedTabs, [workspace]: [] }
      })
    }
    pause.gate.resolve()
    await rejected
    const id = legacyPanePtySessionId(workspace, leafId, '9')
    expect(f.alive.has(id)).toBe(false)
    expect(
      existsSync(join(f.profile, 'terminal-history', encodeURIComponent(id), 'checkpoint.json'))
    ).toBe(true)
  }
)

it('keeps the canonical history address across a durable move and a fresh Store after dispatch-before-bind crash', async () => {
  const f = await restoreFixture()
  await expect(f.start(true)).rejects.toThrow('crash before bind')
  const canonical = 'repo-local::/fixture/local@@e2fec859'
  const newer = new HistoryManager(getDaemonHistoryDir())
  await newer.openSession(canonical, { cwd: f.profile, cols: 80, rows: 24 })
  await newer.checkpoint(canonical, {
    snapshotAnsi: 'newer canonical screen',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: f.profile,
    cols: 80,
    rows: 24,
    scrollbackLines: 0,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    }
  })
  await newer.releaseIdentity('detach')
  const movedTab = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  expect(
    await f.store.moveTerminalLeafToNewTab({
      worktreeId: workspace,
      sourceTabId: tabId,
      targetTabId: movedTab,
      leafId,
      ptyId: '9'
    })
  ).toMatchObject({ status: 'moved' })
  const saved = f.readState()
  expect(saved.workspaceSession.terminalLayoutsByTabId[movedTab].ptyIdsByLeafId[leafId]).toBe('9')
  await f.store.freezeWritesAsync()
  const reopened = new Store({
    userDataPath: f.profile,
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(f.profile, 'profile-state.db'),
      'coordination-test'
    ),
    dataFile: join(f.profile, 'orca-data.json')
  })
  f.alive.clear()
  f.alive.add('9')
  f.seen.length = 0
  try {
    const restored = await f.start(false, movedTab, reopened)
    expect(restored.result.id).toBe(canonical)
    expect(restored.result.coldRestore).toMatchObject({
      scrollback: 'newer canonical screen',
      cwd: f.profile
    })
    expect(f.seen).toEqual([{ id: canonical, attachOnly: false }])
    expect(
      reopened.getWorkspaceSession().terminalLayoutsByTabId[movedTab].ptyIdsByLeafId?.[leafId]
    ).toBe(canonical)
  } finally {
    await reopened.freezeWritesAsync()
  }
})

it.each(['commit', 'rollback'] as const)(
  'transfers a pending conversion and its reservation on a durable move: %s',
  async (outcome) => {
    const f = await restoreFixture()
    const pause = f.pauseFresh()
    const pending = f.start()
    await pause.started
    const movedTab = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    if (outcome === 'rollback') {
      f.authority.failNextWrite()
    }
    try {
      const move = f.store.moveTerminalLeafToNewTab({
        worktreeId: workspace,
        sourceTabId: tabId,
        targetTabId: movedTab,
        leafId,
        ptyId: '9'
      })
      if (outcome === 'rollback') {
        await expect(move).rejects.toThrow()
      } else {
        expect(await move).toMatchObject({ status: 'moved' })
      }
    } finally {
      pause.gate.resolve()
    }
    const result = await pending
    const expectedTab = outcome === 'commit' ? movedTab : tabId
    expect(
      f.store.getWorkspaceSession().terminalLayoutsByTabId[expectedTab].ptyIdsByLeafId?.[leafId]
    ).toBe(result.result.id)
    expect(f.seen.filter((call) => !call.attachOnly)).toHaveLength(1)
    const { paneSpawnReservationsByOwnerKey, pendingRuntimePaneCreatesByOwnerKey } =
      await import('../../ipc/pty/pane/spawn-reservation')
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
    expect(pendingRuntimePaneCreatesByOwnerKey.size).toBe(0)
  }
)

it.each(['during dispatch', 'after commit'] as const)(
  'a destination close owns the moved C and a stale source close does not: %s',
  async (interval) => {
    const f = await restoreFixture()
    const pause = f.pauseFresh()
    const pending = f.start()
    const verdict =
      interval === 'during dispatch'
        ? expect(pending).rejects.toThrow('terminal_pane_owner_changed')
        : undefined
    await pause.started
    const movedTab = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    try {
      expect(
        await f.store.moveTerminalLeafToNewTab({
          worktreeId: workspace,
          sourceTabId: tabId,
          targetTabId: movedTab,
          leafId,
          ptyId: '9'
        })
      ).toMatchObject({ status: 'moved' })
      await f.close()
      expect(f.provider.killFenced).not.toHaveBeenCalled()
      if (interval === 'during dispatch') {
        await f.close(movedTab)
      }
    } finally {
      pause.gate.resolve()
    }
    if (verdict) {
      await verdict
    } else {
      const restored = await pending
      expect(f.alive.has(restored.result.id)).toBe(true)
      await f.close(movedTab)
      await vi.waitFor(() => expect(f.alive.has(restored.result.id)).toBe(false))
    }
    expect(f.provider.killFenced).toHaveBeenCalledWith(
      expect.objectContaining({
        id: legacyPanePtySessionId(workspace, leafId, '9'),
        expectedIncarnationId: `incarnation-${legacyPanePtySessionId(workspace, leafId, '9')}`
      })
    )
  }
)

it('refuses a new stale numeric restore request for the removed source after a move', async () => {
  const f = await restoreFixture()
  const movedTab = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  expect(
    await f.store.moveTerminalLeafToNewTab({
      worktreeId: workspace,
      sourceTabId: tabId,
      targetTabId: movedTab,
      leafId,
      ptyId: '9'
    })
  ).toMatchObject({ status: 'moved' })
  await expect(f.start()).rejects.toThrow('terminal_pane_owner_changed')
  expect(f.seen).toEqual([])
  expect(
    f.store.getWorkspaceSession().terminalLayoutsByTabId[movedTab].ptyIdsByLeafId?.[leafId]
  ).toBe('9')
})

it.each([false, true])(
  'keeps a moved compatible pane usable with late-coordinate=%s',
  async (late) => {
    const f = await restoreFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const read = HistoryReader.prototype.detectColdRestoreState
    const pause = vi
      .spyOn(HistoryReader.prototype, 'detectColdRestoreState')
      .mockImplementation(async function (this: HistoryReader, ...args) {
        if (args[0] === '9') {
          entered.resolve()
          await release.promise
        }
        return read.apply(this, args)
      })
    const pending = f.start(false, tabId, f.store, late)
    try {
      await entered.promise
      const movedTab = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      expect(
        await f.store.moveTerminalLeafToNewTab({
          worktreeId: workspace,
          sourceTabId: tabId,
          targetTabId: movedTab,
          leafId,
          ptyId: '9'
        })
      ).toMatchObject({ status: 'moved' })
      release.resolve()
      const result = await pending
      expect(result.result.id).toBe('9')
      expect(
        f.provider.spawn.mock.calls
          .filter(([options]) => !options.attachOnly)
          .map(([options]) => options.env?.ORCA_PANE_KEY)
      ).toEqual([`${movedTab}:${leafId}`])
      expect(
        f.store.getWorkspaceSession().terminalLayoutsByTabId[movedTab].ptyIdsByLeafId?.[leafId]
      ).toBe('9')
      expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
      expect(
        existsSync(
          join(
            f.profile,
            'terminal-history',
            encodeURIComponent('repo-local::/fixture/local@@e2fec859'),
            'meta.json'
          )
        )
      ).toBe(false)
      const stopClosed = vi.fn()
      await f.close(movedTab, stopClosed)
      expect(stopClosed).toHaveBeenCalledWith(['9'])
      expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[movedTab]).toBeUndefined()
    } finally {
      release.resolve()
      pause.mockRestore()
      await pending.catch(() => {})
    }
  }
)

it.each([
  ['dispatch', 'commit'],
  ['dispatch', 'rollback'],
  ['binding', 'commit'],
  ['binding', 'rollback']
] as const)(
  'publishes the current pane through installed runtime create after a %s move %s',
  async (interval, outcome) => {
    const f = await restoreFixture()
    const { runtime, create } = installedRestore(f)
    const canonical = 'repo-local::/fixture/local@@e2fec859'
    const movedTab = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const bindingEntered = deferred<void>()
    const bindingRelease = deferred<void>()
    const originalBinding = f.store.persistPtyBinding.bind(f.store)
    const binding =
      interval === 'binding'
        ? vi.spyOn(f.store, 'persistPtyBinding').mockImplementation(async (...args) => {
            const value = await originalBinding(...args)
            if (
              f.store.getWorkspaceSession().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[
                leafId
              ] === canonical
            ) {
              bindingEntered.resolve()
              await bindingRelease.promise
            }
            return value
          })
        : undefined
    const pause = interval === 'dispatch' ? f.pauseFresh() : undefined
    const registered = vi.spyOn(runtime, 'registerPty')
    const pending = create()
    try {
      await (pause?.started ?? bindingEntered.promise)
      if (outcome === 'rollback') {
        f.authority.failNextWrite()
      }
      const move = f.store.moveTerminalLeafToNewTab({
        worktreeId: workspace,
        sourceTabId: tabId,
        targetTabId: movedTab,
        leafId,
        ptyId: interval === 'binding' ? canonical : '9'
      })
      if (outcome === 'rollback') {
        await expect(move).rejects.toThrow()
      } else {
        expect(await move).toMatchObject({ status: 'moved' })
      }
      pause?.gate.resolve()
      bindingRelease.resolve()
      const created = await pending
      const expectedTab = outcome === 'commit' ? movedTab : tabId
      expect(created).toMatchObject({
        ptyId: canonical,
        tabId: expectedTab,
        paneKey: `${expectedTab}:${leafId}`
      })
      expect(runtime.resolveTerminalPane(`${expectedTab}:${leafId}`, workspace)).toMatchObject({
        ptyId: canonical
      })
      expect(
        f.store.getWorkspaceSession().terminalLayoutsByTabId[expectedTab]?.ptyIdsByLeafId?.[leafId]
      ).toBe(canonical)
      if (outcome === 'commit') {
        expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
        expect(
          registered.mock.calls
            .filter(([id]) => id === canonical)
            .every((call) => call[3]?.tabId === movedTab)
        ).toBe(true)
      }
      expect(f.seen.filter((call) => !call.attachOnly)).toEqual([
        { id: canonical, attachOnly: false }
      ])
      await runtime.onPtyExit(canonical, 0, `incarnation-${canonical}`, {
        providerExitObserved: true
      })
    } finally {
      pause?.gate.resolve()
      bindingRelease.resolve()
      await pending.catch(() => {})
      binding?.mockRestore()
      registered.mockRestore()
    }
  }
)

it.each(['first conversion', 'committed retry'] as const)(
  'selects before late-coordinate dispatch for %s',
  async (mode) => {
    const f = await restoreFixture()
    const canonical = 'repo-local::/fixture/local@@e2fec859'
    if (mode === 'committed retry') {
      await expect(f.start(true)).rejects.toThrow('crash before bind')
      f.alive.clear()
      f.alive.add('9')
      f.seen.length = 0
    }
    const result = await f.start(false, tabId, f.store, true)
    expect(result.result.id).toBe(canonical)
    expect(result.result.coldRestore).toMatchObject({
      scrollback: 'old terminal screen',
      cwd: '/fixture/local'
    })
    expect(f.seen).toEqual(
      mode === 'first conversion'
        ? [
            { id: '9', attachOnly: true },
            { id: canonical, attachOnly: false }
          ]
        : [{ id: canonical, attachOnly: false }]
    )
    expect(
      f.readState().workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
    ).toBe(canonical)
    await f.close()
    expect(f.alive.has(canonical)).toBe(false)
  }
)
