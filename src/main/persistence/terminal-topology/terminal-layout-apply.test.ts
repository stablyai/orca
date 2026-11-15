import { withoutGitGraph } from '../../../shared/workspace-layout/client-views/workspace-layout-client-visibility'
import type { LayoutEffects } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Store } from '../loading-store/store'
import { WindowSession } from './testing/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './testing/terminal-topology-profile-fixture'

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
})

it('admits competing initial requests against visible tabs inside the durable mutation', async () => {
  const { store } = await storeWithOneTab()
  await store.applyLayoutCommand({
    type: 'closeTabs',
    workspace: WORKTREE,
    tabIds: [TAB],
    force: true
  })
  await store.applyLayoutCommand({
    type: 'openEditorTab',
    workspace: WORKTREE,
    tabId: 'graph',
    fileId: 'graph',
    contentType: 'git-graph',
    view: {
      view: { mode: 'git-graph' },
      file: { filePath: 'graph', relativePath: 'graph', language: 'plaintext' }
    },
    groupId: 'hidden'
  })
  const effects: LayoutEffects[] = []
  const run = {
    visibility: withoutGitGraph,
    onEffects: (effect: LayoutEffects) => effects.push(effect)
  }
  await expect(
    store.applyLayoutCommand(
      { type: 'createTerminalTab', workspace: WORKTREE, tabId: 'restored', initial: 'restore' },
      ['local'],
      run
    )
  ).resolves.toEqual({ ok: true, result: {} })
  const replies = await Promise.all([
    store.applyLayoutCommand(
      {
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: 'first',
        leafId: LEAF,
        groupId: 'old-root',
        initial: 'activation'
      },
      ['local'],
      run
    ),
    store.applyLayoutCommand(
      {
        type: 'openAgentSessionTab',
        workspace: WORKTREE,
        tabId: 'second',
        sessionId: 'session',
        agent: 'codex',
        initial: 'activation'
      },
      ['local'],
      run
    )
  ])
  expect(replies).toMatchObject([
    { ok: true, result: { tabId: 'first' } },
    { ok: true, result: {} }
  ])
  expect(
    store.getWorkspaceSession().tabGroups?.[WORKTREE]?.map(({ id, tabOrder }) => ({ id, tabOrder }))
  ).toEqual([{ id: 'hidden', tabOrder: ['graph', 'first'] }])
  expect(effects.flatMap((effect) => effect.startPaneKeys)).toEqual([`first:${LEAF}`])
  expect(effects.flatMap((effect) => effect.stopPtyIds)).toEqual([])
})
