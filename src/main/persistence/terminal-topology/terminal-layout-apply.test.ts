import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
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
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function storeWithOneTab(
  hostId?: string,
  worktreeId = WORKTREE
): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-layout-apply-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(worktreeId, TAB, LEAF)
  window.bind(TAB, LEAF, 'pty-1')
  store.setWorkspaceSession(window.snapshot(), hostId)
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

const split = {
  type: 'splitPane',
  workspace: WORKTREE,
  tabId: TAB,
  leafId: LEAF,
  direction: 'vertical'
} as const

describe('Store.applyLayoutCommand (layout.apply)', () => {
  it('writes a split durably, with a pane id main minted', async () => {
    const { store, directory } = await storeWithOneTab()

    const reply = await store.applyLayoutCommand(split)

    expect(reply.ok).toBe(true)
    const leafId = reply.ok ? reply.result.leafId : undefined
    expect(leafId).toMatch(UUID)
    expect(reply.ok && reply.result.paneKey).toBe(`${TAB}:${leafId}`)
    const reopened = await reopenTopologyStore(store, directory)
    const layout = reopened.getWorkspaceSession().terminalLayoutsByTabId[TAB]
    expect(layout?.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF },
      second: { type: 'leaf', leafId }
    })
    // Pane mounting starts its terminal later.
    expect(layout?.ptyIdsByLeafId).toEqual({ [LEAF]: 'pty-1' })
  })

  it('records a window’s tab close durably, so a late start of it is refused', async () => {
    const { store, directory } = await storeWithOneTab()
    const revision = (key: Store) =>
      Object.values(key.getWorkspaceSession().terminalTopologyRevisionByRepoId ?? {})[0] ?? 0
    const revisionBefore = revision(store)

    const reply = await store.applyLayoutCommand({
      type: 'closeTabs',
      workspace: WORKTREE,
      tabIds: [TAB],
      force: true,
      recordClose: 'user'
    })

    expect(reply).toEqual({ ok: true, result: { closed: [TAB], refused: [] } })
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.tabsByWorktree[WORKTREE] ?? []).toEqual([])
    expect(session.closedTerminalTabTombstonesByTabId?.[TAB]).toMatchObject({
      worktreeId: WORKTREE,
      reason: 'user'
    })
    expect(revision(store)).toBeGreaterThan(revisionBefore)
  })

  it('prunes the partition’s expired close records when it records one, as today', async () => {
    const { store } = await storeWithOneTab()
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      closedTerminalTabTombstonesByTabId: {
        'tab-old': { worktreeId: 'repo-other::/x', closedAt: 1, reason: 'user' }
      }
    })

    await store.applyLayoutCommand({
      type: 'closeTabs',
      workspace: WORKTREE,
      tabIds: [TAB],
      force: true,
      recordClose: 'cleanup'
    })

    expect(
      Object.keys(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId ?? {})
    ).toEqual([TAB])
  })

  it('writes a folder workspace’s split', async () => {
    const { store } = await storeWithOneTab(undefined, FIXTURE_FOLDER_WORKTREE_ID)

    const reply = await store.applyLayoutCommand({
      ...split,
      workspace: FIXTURE_FOLDER_WORKTREE_ID
    })

    expect(reply.ok).toBe(true)
    const root = store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root
    expect(leafIds(root)).toEqual([LEAF, reply.ok ? reply.result.leafId : undefined])
  })

  it('keeps records the split did not touch exactly as stored', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-layout-apply-'))
    directories.push(directory)
    const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
    const window = new WindowSession(getDefaultWorkspaceSession())
    window.addTab(WORKTREE, TAB, LEAF)
    window.bind(TAB, LEAF, 'pty-1')
    // Verify record patches preserve residue that full load/save normalization would drop.
    window.session.terminalPtyIncarnationsByPaneKey = { [`${TAB}:${LEAF}`]: 'incarnation-1' }
    window.session.tabsByWorktree[WORKTREE]![0]!.sortOrder = 7
    store.setWorkspaceSession(window.snapshot())
    const stored = store.getWorkspaceSession()

    await store.applyLayoutCommand(split)

    const written = store.getWorkspaceSession()
    expect(written.terminalPtyIncarnationsByPaneKey).toEqual(
      stored.terminalPtyIncarnationsByPaneKey
    )
    expect(written.tabsByWorktree).toEqual(stored.tabsByWorktree)
    expect(written.unifiedTabs).toEqual(stored.unifiedTabs)
  })

  it('refuses a pane main does not hold and writes nothing', async () => {
    const { store } = await storeWithOneTab()
    const before = store.getWorkspaceSession()

    const reply = await store.applyLayoutCommand({ ...split, leafId: 'missing-leaf' })

    expect(reply).toEqual({ ok: false, code: 'pane_not_found' })
    expect(store.getWorkspaceSession()).toEqual(before)
  })

  it('writes an SSH workspace’s split into that host’s partition only', async () => {
    const { store } = await storeWithOneTab('ssh:target-1')
    const local = store.getWorkspaceSession()

    const reply = await store.applyLayoutCommand(split, ['ssh:target-1'])

    expect(reply.ok).toBe(true)
    const root = store.getWorkspaceSession('ssh:target-1').terminalLayoutsByTabId[TAB]?.root
    expect(leafIds(root)).toHaveLength(2)
    expect(store.getWorkspaceSession()).toEqual(local)
  })
})
