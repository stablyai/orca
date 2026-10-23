import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
vi.mock('./ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

const REPO = 'repo-a'
const WORKTREE = `${REPO}::/work/a`
const LEAF = '11111111-1111-4111-8111-111111111111'

/** An older build's save: the terminal is named on the tab, its one pane binds nothing. */
function tabLevelOnly(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [makeTerminalTab({ id: 'tab-a', ptyId: 'pty-a', worktreeId: WORKTREE })]
    },
    terminalLayoutsByTabId: {
      'tab-a': { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    activeWorktreeIdsOnShutdown: [WORKTREE]
  }
}

function loadStored(session = tabLevelOnly()): WorkspaceSessionState {
  writeDataFile({
    schemaVersion: 1,
    repos: [makeRepo({ id: REPO, path: '/work/a' })],
    worktreeMeta: {},
    workspaceSession: session
  })
  return createStore().getWorkspaceSession()
}

describe("main's Store load binds a tab's own terminal to its unbound pane", () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-tab-terminal-binding-load-'))
  })

  afterEach(async () => {
    layoutOwner.isMain = true
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('in a layout-owner build', () => {
    expect(loadStored().terminalLayoutsByTabId['tab-a']?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-a'
    })
  })

  it("after the load purge, so a dropped workspace's pane cannot hold the terminal", () => {
    const session = tabLevelOnly()
    const gone = 'legacy-bare-key'
    session.tabsByWorktree[gone] = [makeTerminalTab({ id: 'tab-gone', worktreeId: gone })]
    session.terminalLayoutsByTabId['tab-gone'] = {
      root: { type: 'leaf', leafId: LEAF.replace(/1/g, '2') },
      activeLeafId: LEAF.replace(/1/g, '2'),
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF.replace(/1/g, '2')]: 'pty-a' }
    }
    const loaded = loadStored(session)
    expect(Object.keys(loaded.tabsByWorktree)).toEqual([WORKTREE])
    expect(loaded.terminalLayoutsByTabId['tab-a']?.ptyIdsByLeafId).toEqual({ [LEAF]: 'pty-a' })
  })

  it('not while the window owns the layout', () => {
    layoutOwner.isMain = false
    expect(loadStored().terminalLayoutsByTabId['tab-a']?.ptyIdsByLeafId).toBeUndefined()
  })
})
