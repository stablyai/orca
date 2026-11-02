import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { Store } from '../loading-store/store'
import { leafIds, WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const GROUP = `group-${WORKTREE}`
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_TAB = 'tab-new'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function openStore(
  seed: (window: WindowSession) => void,
  hostId?: string
): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-layout-create-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  seed(window)
  store.setWorkspaceSession(window.snapshot(), hostId)
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

const withOneTab = (window: WindowSession): void => {
  window.addTab(WORKTREE, TAB, LEAF)
  window.bind(TAB, LEAF, 'pty-1')
}

const create: CommandOf<'createTerminalTab'> = {
  type: 'createTerminalTab',
  workspace: WORKTREE,
  tabId: NEW_TAB,
  leafId: NEW_LEAF,
  groupId: GROUP,
  creation: { defaultTitle: 'Terminal 2', startupCwd: '/fixture/local/src' }
}

describe('Store.applyLayoutCommand: a window’s terminal tab create', () => {
  it('writes the tab durably under the window’s ids, in the group it names', async () => {
    const { store, directory } = await openStore(withOneTab)

    const reply = await store.applyLayoutCommand(create)

    expect(reply).toEqual({
      ok: true,
      result: { tabId: NEW_TAB, leafId: NEW_LEAF, paneKey: `${NEW_TAB}:${NEW_LEAF}` }
    })
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.terminalLayoutsByTabId[NEW_TAB]?.root).toEqual({
      type: 'leaf',
      leafId: NEW_LEAF
    })
    const row = session.tabsByWorktree[WORKTREE]?.find((tab) => tab.id === NEW_TAB)
    expect(row).toMatchObject({ defaultTitle: 'Terminal 2', startupCwd: '/fixture/local/src' })
    expect(session.tabGroups?.[WORKTREE]?.[0]).toMatchObject({
      id: GROUP,
      tabOrder: [TAB, NEW_TAB]
    })
  })

  it('then accepts a split of the new pane before any window save', async () => {
    const { store } = await openStore(withOneTab)
    await store.applyLayoutCommand(create)

    const reply = await store.applyLayoutCommand({
      type: 'splitPane',
      workspace: WORKTREE,
      tabId: NEW_TAB,
      leafId: NEW_LEAF,
      direction: 'vertical'
    })

    expect(reply.ok).toBe(true)
    const root = store.getWorkspaceSession().terminalLayoutsByTabId[NEW_TAB]?.root
    expect(leafIds(root)).toEqual([NEW_LEAF, reply.ok ? reply.result.leafId : undefined])
  })

  it('treats the same create again as done, and writes nothing', async () => {
    const { store } = await openStore(withOneTab)
    await store.applyLayoutCommand(create)
    const before = store.getWorkspaceSession()

    const reply = await store.applyLayoutCommand({ ...create, groupId: 'another-group' })

    expect(reply).toEqual({
      ok: true,
      result: { tabId: NEW_TAB, leafId: NEW_LEAF, paneKey: `${NEW_TAB}:${NEW_LEAF}` }
    })
    expect(store.getWorkspaceSession()).toBe(before)
  })

  it('refuses an id another tab holds, in this workspace or another, and writes nothing', async () => {
    const { store } = await openStore((window) => {
      withOneTab(window)
      window.addTab(FIXTURE_FOLDER_WORKTREE_ID, 'folder-tab', NEW_LEAF)
    })
    const before = store.getWorkspaceSession()

    expect(await store.applyLayoutCommand({ ...create, tabId: TAB })).toEqual({
      ok: false,
      code: 'tab_exists'
    })
    expect(await store.applyLayoutCommand({ ...create, tabId: 'folder-tab' })).toEqual({
      ok: false,
      code: 'tab_exists'
    })
    expect(store.getWorkspaceSession()).toBe(before)
  })

  it('keeps records the create did not touch exactly as stored', async () => {
    const { store } = await openStore((window) => {
      withOneTab(window)
      // Leftovers a full load-and-save rewrite would drop or renumber.
      window.session.terminalPtyIncarnationsByPaneKey = { [`${TAB}:${LEAF}`]: 'incarnation-1' }
      window.session.tabsByWorktree[WORKTREE]![0]!.sortOrder = 7
    })
    const stored = store.getWorkspaceSession()

    await store.applyLayoutCommand(create)

    const written = store.getWorkspaceSession()
    expect(written.terminalPtyIncarnationsByPaneKey).toEqual(
      stored.terminalPtyIncarnationsByPaneKey
    )
    expect(written.tabsByWorktree[WORKTREE]?.[0]).toEqual(stored.tabsByWorktree[WORKTREE]?.[0])
    expect(written.unifiedTabs?.[WORKTREE]?.[0]).toEqual(stored.unifiedTabs?.[WORKTREE]?.[0])
  })

  it('makes a workspace’s first tab on activation only while main’s copy holds no tab', async () => {
    const { store } = await openStore(withOneTab)
    const before = store.getWorkspaceSession()
    const initial = { ...create, groupId: undefined, initial: 'activation' as const }

    expect(await store.applyLayoutCommand(initial)).toEqual({ ok: true, result: {} })
    expect(store.getWorkspaceSession()).toBe(before)

    const empty = await store.applyLayoutCommand({
      ...initial,
      workspace: FIXTURE_FOLDER_WORKTREE_ID
    })
    expect(empty.ok && empty.result.tabId).toBe(NEW_TAB)
    expect(
      store.getWorkspaceSession().tabsByWorktree[FIXTURE_FOLDER_WORKTREE_ID]?.map((tab) => tab.id)
    ).toEqual([NEW_TAB])
  })

  it('writes an SSH workspace’s tab into that host’s partition only', async () => {
    const { store } = await openStore(withOneTab, 'ssh:target-1')
    const local = store.getWorkspaceSession()

    const reply = await store.applyLayoutCommand(create, ['ssh:target-1'])

    expect(reply.ok).toBe(true)
    expect(store.getWorkspaceSession('ssh:target-1').terminalLayoutsByTabId[NEW_TAB]?.root).toEqual(
      { type: 'leaf', leafId: NEW_LEAF }
    )
    expect(store.getWorkspaceSession()).toEqual(local)
  })
})
