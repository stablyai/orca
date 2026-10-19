import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Store } from '../loading-store/store'
import { WindowSession } from './terminal-topology-window-session-fixture'
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

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function storeWithTerminal(worktreeId: string): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-open-split-apply-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(worktreeId, TAB, LEAF)
  store.setWorkspaceSession(window.snapshot())
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

describe.each([
  ['a git worktree', FIXTURE_GIT_WORKTREE_ID],
  ['a folder workspace', FIXTURE_FOLDER_WORKTREE_ID]
])('Store.applyLayoutCommand opening into a new split in %s', (_name, worktreeId) => {
  it('saves each new split with its tab, durably, and never an empty one', async () => {
    const { store, directory } = await storeWithTerminal(worktreeId)
    const source = store.getWorkspaceSession().tabGroups?.[worktreeId]?.[0]?.id
    expect(source).toBeDefined()

    await expect(
      store.applyLayoutCommand({
        type: 'createTerminalTab',
        workspace: worktreeId,
        tabId: NEW_TAB,
        leafId: NEW_LEAF,
        groupId: 'terminal-split',
        split: { besideGroupId: source!, direction: 'right' }
      })
    ).resolves.toMatchObject({ ok: true, result: { tabId: NEW_TAB } })
    await expect(
      store.applyLayoutCommand({
        type: 'openEditorTab',
        workspace: worktreeId,
        tabId: 'editor-tab',
        fileId: '/a.ts',
        contentType: 'editor',
        groupId: 'editor-split',
        split: { besideGroupId: 'terminal-split', direction: 'down' }
      })
    ).resolves.toMatchObject({ ok: true, result: { tabId: 'editor-tab' } })
    // Beside a split main lacks: refused, nothing written.
    await expect(
      store.applyLayoutCommand({
        type: 'openEditorTab',
        workspace: worktreeId,
        tabId: 'stray',
        fileId: '/b.ts',
        contentType: 'editor',
        groupId: 'stray-split',
        split: { besideGroupId: 'window-only', direction: 'left' }
      })
    ).resolves.toEqual({ ok: false, code: 'group_not_found' })

    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.tabGroups?.[worktreeId]?.map(({ id, tabOrder }) => ({ id, tabOrder }))).toEqual([
      { id: source, tabOrder: [TAB] },
      { id: 'terminal-split', tabOrder: [NEW_TAB] },
      { id: 'editor-split', tabOrder: ['editor-tab'] }
    ])
    expect(session.tabGroupLayouts?.[worktreeId]).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: source },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: 'terminal-split' },
        second: { type: 'leaf', groupId: 'editor-split' },
        ratio: 0.5
      },
      ratio: 0.5
    })
    expect(session.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([TAB, NEW_TAB])
  })
})
