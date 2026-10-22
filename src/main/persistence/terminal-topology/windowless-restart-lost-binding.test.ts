import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
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
const TAB = 'tab-cli'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = 'pty-live'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** What a serve host with no window stores for a client-created terminal, as main writes it. */
async function windowlessHostWithTerminal(): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-windowless-restart-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const created = await store.applyLayoutCommand({
    type: 'createTerminalTab',
    workspace: WORKTREE,
    tabId: TAB,
    leafId: LEAF
  })
  expect(created.ok).toBe(true)
  await store.persistPtyBinding({
    worktreeId: WORKTREE,
    tabId: TAB,
    leafId: LEAF,
    ptyId: PTY,
    incarnationId: 'inc-1'
  })
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

/** The reported loss: the pane's binding is gone; the tab, its pane tree and the PTY stay. */
function withoutPaneBinding(session: WorkspaceSessionState): WorkspaceSessionState {
  const layout = session.terminalLayoutsByTabId[TAB]!
  return {
    ...session,
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [TAB]: { ...layout, ptyIdsByLeafId: {} }
    }
  }
}

describe('a windowless host restarted after a pane lost its terminal binding (layout-owner build)', () => {
  it('keeps the tab and binds its pane again from the tab row', async () => {
    const { store, directory } = await windowlessHostWithTerminal()
    const stored = store.getWorkspaceSession()
    expect(stored.activeWorktreeIdsOnShutdown).toBeUndefined()
    store.setWorkspaceSession(withoutPaneBinding(stored))

    const relaunched = await reopenTopologyStore(store, directory)
    const session = relaunched.getWorkspaceSession()

    expect(session.tabsByWorktree[WORKTREE]?.map((row) => row.id)).toEqual([TAB])
    expect(leafIds(session.terminalLayoutsByTabId[TAB]?.root)).toEqual([LEAF])
    expect(session.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({ [LEAF]: PTY })
  })
})
