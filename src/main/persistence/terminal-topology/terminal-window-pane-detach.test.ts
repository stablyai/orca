import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { makeRepo } from '../../persistence-test-harness'
import type { Store } from '../loading-store/store'
import {
  closeMoveTestStores,
  FROM,
  LEFT,
  MOVED,
  newDataFile,
  openStore,
  ownersOf,
  seedSplitSource,
  sleeping,
  SOURCE,
  TARGET,
  tabsHoldingLeaf,
  TO,
  WT
} from './terminal-leaf-move-fixture'

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
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

afterEach(closeMoveTestStores)

/** The window's drag-out as `layout.apply` sends it, with the tab id pinned for the assertions. */
function detach(
  store: Store,
  ptyId: string | null,
  hostIds: ExecutionHostId[] = ['local'],
  startupCwd?: string
): ReturnType<Store['applyLayoutCommand']> {
  return store.applyLayoutCommand(
    {
      type: 'movePaneToNewTab',
      workspace: WT,
      tabId: SOURCE,
      leafId: MOVED,
      windowDetach: { ptyId, tabId: TARGET, ...(startupCwd ? { startupCwd } : {}) }
    },
    hostIds
  )
}

// The desktop's move rules (terminal-leaf-move.test.ts), through layout.apply's pane move.
describe('a window drag-out through layout.apply', () => {
  it('moves the leaf and its binding in one write and re-keys pane-keyed records', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [FROM]: sleeping(FROM, SOURCE) }
    })
    store.updateUI({
      acknowledgedAgentsByPaneKey: { [FROM]: 10 },
      activityClearedAtByPaneKey: { [FROM]: 11 },
      manuallyUnreadTurnsByPaneKey: { [FROM]: 12 }
    })

    await expect(detach(store, 'pty-agent')).resolves.toEqual({
      ok: true,
      result: { tabId: TARGET, ptyId: 'pty-agent' }
    })

    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId[SOURCE]).toMatchObject({
      root: { type: 'leaf', leafId: LEFT },
      ptyIdsByLeafId: { [LEFT]: 'pty-left' }
    })
    expect(session.terminalLayoutsByTabId[TARGET]).toMatchObject({
      root: { type: 'leaf', leafId: MOVED },
      ptyIdsByLeafId: { [MOVED]: 'pty-agent' }
    })
    expect(session.tabsByWorktree[WT]?.map((tab) => [tab.id, tab.ptyId])).toEqual([
      [SOURCE, 'pty-left'],
      [TARGET, 'pty-agent']
    ])
    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      [`${SOURCE}:${LEFT}`]: 'inc-left',
      [TO]: 'inc-1'
    })
    expect(session.sleepingAgentSessionsByPaneKey).toEqual({
      [TO]: expect.objectContaining({ paneKey: TO, tabId: TARGET })
    })
    expect(store.getUI()).toMatchObject({
      acknowledgedAgentsByPaneKey: { [TO]: 10 },
      activityClearedAtByPaneKey: { [TO]: 11 },
      manuallyUnreadTurnsByPaneKey: { [TO]: 12 }
    })
    expect(ownersOf(session, 'pty-agent')).toEqual([TO])
  })

  it('re-keys the SSH lease within the partition that holds the tab', async () => {
    const dataFile = newDataFile()
    writeFileSync(
      dataFile,
      JSON.stringify({
        sshRemotePtyLeases: [
          {
            targetId: 'ssh-1',
            ptyId: 'pty-agent',
            worktreeId: WT,
            tabId: SOURCE,
            leafId: MOVED,
            state: 'attached'
          }
        ]
      })
    )
    const store = openStore(dataFile)
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)

    await expect(detach(store, 'pty-agent', [hostId])).resolves.toMatchObject({ ok: true })

    expect(tabsHoldingLeaf(store.getWorkspaceSession(hostId), MOVED)).toEqual([TARGET])
    expect(store.getWorkspaceSession().tabsByWorktree[WT]).toBeUndefined()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({ ptyId: 'pty-agent', tabId: TARGET, leafId: MOVED })
    ])
  })

  it('moves the last pane of main’s copy, leaving the tab for the window’s other panes', async () => {
    const store = openStore(newDataFile())
    await store.persistPtyBinding({
      worktreeId: WT,
      tabId: SOURCE,
      leafId: MOVED,
      ptyId: 'pty-agent',
      incarnationId: 'inc-1'
    })

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main holds every pane the window shows, so a one-pane copy is the tab's last pane (L127).
      await expect(detach(store, 'pty-agent')).resolves.toEqual({ ok: false, code: 'last_pane' })
      expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([SOURCE])
      return
    }
    await expect(detach(store, 'pty-agent')).resolves.toMatchObject({ ok: true })

    const session = store.getWorkspaceSession()
    expect(tabsHoldingLeaf(session, MOVED)).toEqual([TARGET])
    expect(session.tabsByWorktree[WT]?.find((tab) => tab.id === SOURCE)?.ptyId).toBeNull()
    // The window's sibling binds into the source tab later.
    expect(
      await store.persistPtyBinding({
        worktreeId: WT,
        tabId: SOURCE,
        leafId: LEFT,
        ptyId: 'pty-left',
        incarnationId: 'inc-left'
      })
    ).toBe(true)
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), LEFT)).toEqual([SOURCE])
  })

  it('starts an unbound pane’s new tab in the folder the window sent', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    const seeded = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...seeded,
      terminalLayoutsByTabId: {
        [SOURCE]: {
          ...seeded.terminalLayoutsByTabId[SOURCE]!,
          ptyIdsByLeafId: { [LEFT]: 'pty-left' }
        }
      }
    })

    await expect(detach(store, null, ['local'], '/wt/app')).resolves.toMatchObject({
      ok: true,
      result: { tabId: TARGET, ptyId: null }
    })

    const target = store.getWorkspaceSession().tabsByWorktree[WT]?.find((tab) => tab.id === TARGET)
    expect(target?.startupCwd).toBe('/wt/app')
  })

  it('refuses a terminal no copy names, and a leaf another tab holds', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main's binding names the moved terminal; the window's claim is not consulted (L127).
      const claimed = openStore(newDataFile())
      await seedSplitSource(claimed)
      await expect(detach(claimed, 'pty-other')).resolves.toEqual({
        ok: true,
        result: { tabId: TARGET, ptyId: 'pty-agent' }
      })
    } else {
      await expect(detach(store, 'pty-other')).resolves.toEqual({ ok: false, code: 'pty_mismatch' })
    }
    const session = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WT]: [
          ...(session.tabsByWorktree[WT] ?? []),
          { ...(session.tabsByWorktree[WT] ?? [])[0]!, id: 'tab-earlier-move' }
        ]
      },
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        'tab-earlier-move': {
          root: { type: 'leaf', leafId: MOVED },
          activeLeafId: MOVED,
          expandedLeafId: null
        }
      }
    })
    await expect(detach(store, 'pty-agent')).resolves.toEqual({
      ok: false,
      code: 'pane_in_other_tab'
    })
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toContain(SOURCE)
  })

  it('takes the one bound terminal when the window has none', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    await expect(detach(store, null)).resolves.toEqual({
      ok: true,
      result: { tabId: TARGET, ptyId: 'pty-agent' }
    })
  })

  it('moves the remote session id with the moved terminal', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      remoteSessionIdsByTabId: { [SOURCE]: 'pty-agent' }
    })

    await detach(store, 'pty-agent')

    expect(store.getWorkspaceSession().remoteSessionIdsByTabId).toEqual({
      [SOURCE]: 'pty-left',
      [TARGET]: 'pty-agent'
    })
  })
})

describe('a window drag-out of an SSH pane held by both partitions', () => {
  it('moves every copy, so the target reattach and the next relay reattach both bind', async () => {
    const store = openStore(newDataFile())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, leafId: MOVED, ptyId: 'pty-agent', incarnationId: 'inc-1' }
    await store.persistPtyBinding({ ...relay, tabId: SOURCE, origin: 'relay_reattach' })

    await expect(detach(store, 'pty-agent', [hostId, 'local'])).resolves.toMatchObject({
      ok: true
    })

    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])
    expect(tabsHoldingLeaf(store.getWorkspaceSession(hostId), MOVED)).toEqual([TARGET])
    expect(
      await store.persistPtyBinding({ ...relay, tabId: TARGET, origin: 'reattach' }, hostId)
    ).toBe(true)
    expect(
      await store.persistPtyBinding({
        ...relay,
        tabId: TARGET,
        origin: 'relay_reattach',
        mayReviveRetiredSurface: false
      })
    ).toBe(true)
  })

  it('follows the live terminal when an SSH respawn bound one partition before the other', async () => {
    const store = openStore(newDataFile())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, tabId: SOURCE, leafId: MOVED, incarnationId: 'inc-1' }
    await store.persistPtyBinding({ ...relay, ptyId: 'pty-agent', origin: 'relay_reattach' })
    await store.persistPtyBinding(
      { ...relay, ptyId: 'pty-respawn', incarnationId: 'inc-2' },
      hostId
    )

    await expect(detach(store, 'pty-respawn', [hostId, 'local'])).resolves.toEqual({
      ok: true,
      result: { tabId: TARGET, ptyId: 'pty-respawn' }
    })

    for (const session of [store.getWorkspaceSession(), store.getWorkspaceSession(hostId)]) {
      expect(tabsHoldingLeaf(session, MOVED)).toEqual([TARGET])
      expect(session.terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId).toEqual({
        [MOVED]: 'pty-respawn'
      })
    }
    expect(store.getWorkspaceSession(hostId).terminalPtyIncarnationsByPaneKey?.[TO]).toBe('inc-2')
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[TO]).toBeUndefined()
  })
})

// STA-9259 through layout.apply: move, reattach, a stale pre-move renderer save, restart.
describe('STA-9259 sequence through layout.apply', () => {
  it('keeps one owner through reattach, a stale renderer save and a restart', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
    await seedSplitSource(store)
    const preMoveRendererSnapshot = structuredClone(store.getWorkspaceSession())

    await detach(store, 'pty-agent')
    expect(
      await store.persistPtyBinding({
        worktreeId: WT,
        tabId: TARGET,
        leafId: MOVED,
        ptyId: 'pty-agent',
        incarnationId: 'inc-1',
        expectedBinding: { ptyId: 'pty-agent', incarnationId: 'inc-1' },
        origin: 'reattach'
      })
    ).toBe(true)
    store.setWorkspaceSession(preMoveRendererSnapshot)
    expect(ownersOf(store.getWorkspaceSession(), 'pty-agent')).toEqual([TO])
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])

    store.flush()
    const restarted = openStore(dataFile)
    expect(ownersOf(restarted.getWorkspaceSession(), 'pty-agent')).toEqual([TO])
    expect(tabsHoldingLeaf(restarted.getWorkspaceSession(), MOVED)).toEqual([TARGET])
  })
})
