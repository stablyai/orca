import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { Store } from '../loading-store/store'
import { leafIds } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const leaf = (n: number): string => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const on = { workspace: WORKTREE }

async function apply(store: Store, command: LayoutCommand): Promise<void> {
  const result = await store.applyLayoutCommand(command)
  expect(result.ok, command.type).toBe(true)
}

async function bind(store: Store, tabId: string, leafId: string, ptyId: string): Promise<void> {
  await store.persistPtyBinding({
    worktreeId: WORKTREE,
    tabId,
    leafId,
    ptyId,
    incarnationId: `inc-${ptyId}`
  })
}

function terminalsOf(session: WorkspaceSessionState) {
  return {
    rows: (session.tabsByWorktree[WORKTREE] ?? []).map((row) => [row.id, row.ptyId]),
    tabBar: (session.unifiedTabs?.[WORKTREE] ?? []).map((tab) => tab.id),
    panes: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId).map(([tabId, layout]) => [
        tabId,
        { leaves: leafIds(layout.root), bindings: layout.ptyIdsByLeafId }
      ])
    ),
    sleeping: Object.keys(session.sleepingAgentSessionsByPaneKey ?? {})
  }
}

describe('a windowless host reloaded in the layout-owner build', () => {
  it('drops no terminal tab, pane or sleeping agent that main wrote itself', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-windowless-reload-'))
    directories.push(directory)
    const store = await openTopologyStore(directory, emptyTerminalSessionProfile())

    await apply(store, { ...on, type: 'createTerminalTab', tabId: 'tab-split', leafId: leaf(1) })
    await bind(store, 'tab-split', leaf(1), 'pty-1')
    await apply(store, {
      ...on,
      type: 'splitPane',
      tabId: 'tab-split',
      leafId: leaf(1),
      direction: 'vertical',
      newLeafId: leaf(2)
    })
    await bind(store, 'tab-split', leaf(2), 'pty-2')
    await apply(store, { ...on, type: 'createTerminalTab', tabId: 'tab-closed', leafId: leaf(3) })
    await bind(store, 'tab-closed', leaf(3), 'pty-3')
    await apply(store, { ...on, type: 'closeTabs', tabIds: ['tab-closed'] })
    await apply(store, { ...on, type: 'createTerminalTab', tabId: 'tab-asleep', leafId: leaf(4) })
    await bind(store, 'tab-asleep', leaf(4), 'pty-4')
    const paneKey = makePaneKey('tab-asleep', leaf(4))
    await apply(store, {
      ...on,
      type: 'sleep',
      paneKeys: [paneKey],
      records: [
        {
          paneKey,
          tabId: 'tab-asleep',
          worktreeId: WORKTREE,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-4' },
          prompt: 'p',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      ]
    })
    await apply(store, {
      ...on,
      type: 'createTerminalTab',
      tabId: 'tab-unstarted',
      leafId: leaf(5)
    })
    await store.flushPendingOrThrowAsync()
    const written = terminalsOf(store.getWorkspaceSession())
    expect(written.rows.map(([id]) => id)).toEqual(['tab-split', 'tab-asleep', 'tab-unstarted'])
    expect(written.sleeping).toEqual([paneKey])

    const relaunched = await reopenTopologyStore(store, directory)

    expect(terminalsOf(relaunched.getWorkspaceSession())).toEqual(written)
  })
})
