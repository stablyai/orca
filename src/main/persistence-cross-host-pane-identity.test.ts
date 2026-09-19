import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { isTerminalLeafId } from '../shared/stable-pane-id'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const SHARED_TAB_ID = 'tab-shared'

function makeLegacyPaneSession(repoId: string, ptyId: string): WorkspaceSessionState {
  const worktreeId = `${repoId}::/worktree`
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: repoId,
    activeWorktreeId: worktreeId,
    activeTabId: SHARED_TAB_ID,
    tabsByWorktree: {
      [worktreeId]: [makeTerminalTab({ id: SHARED_TAB_ID, worktreeId, ptyId })]
    },
    terminalLayoutsByTabId: {
      [SHARED_TAB_ID]: {
        root: { type: 'leaf', leafId: 'pane:1' },
        activeLeafId: 'pane:1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'pane:1': ptyId }
      }
    }
  }
}

describe('cross-host pane identity migration', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses hostless alias and acknowledgement rewrites for a tab id two partitions share', async () => {
    writeDataFile({
      schemaVersion: 1,
      // Registered on purpose: rows owned by an unregistered repo id are swept as orphans on load.
      repos: [
        makeRepo({ id: 'repo-local', path: '/repo-local' }),
        makeRepo({ id: 'repo-a', path: '/repo-a' })
      ],
      workspaceSession: makeLegacyPaneSession('repo-local', 'local-pty'),
      workspaceSessionsByHostId: {
        'ssh:host-a': makeLegacyPaneSession('repo-a', 'pty-a')
      },
      ui: { acknowledgedAgentsByPaneKey: { 'tab-shared:pane:1': 500 } },
      sshRemotePtyLeases: [
        {
          targetId: 'host-a',
          ptyId: 'pty-a',
          worktreeId: 'repo-a::/worktree',
          tabId: SHARED_TAB_ID,
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    const localRoot = store.getWorkspaceSession('local').terminalLayoutsByTabId[SHARED_TAB_ID]?.root
    const hostRoot =
      store.getWorkspaceSession('ssh:host-a').terminalLayoutsByTabId[SHARED_TAB_ID]?.root
    const localLeaf = localRoot?.type === 'leaf' ? localRoot.leafId : null
    const hostLeaf = hostRoot?.type === 'leaf' ? hostRoot.leafId : null

    // Leaf maps and leases are host-scoped, so each partition still gets its own identity.
    expect(localLeaf && isTerminalLeafId(localLeaf)).toBe(true)
    expect(hostLeaf).not.toBe(localLeaf)
    expect(store.getSshRemotePtyLeases('host-a')[0]?.leafId).toBe(hostLeaf)

    store.flush()
    const persisted = readDataFile() as {
      legacyPaneKeyAliasEntries?: { legacyPaneKey: string }[]
      ui?: { acknowledgedAgentsByPaneKey?: Record<string, number> }
    }
    // `tab-shared:1` and `tab-shared:pane:1` carry no host segment; either rewrite pins one host's pane to the other's terminal.
    expect(
      persisted.legacyPaneKeyAliasEntries?.some((entry) =>
        entry.legacyPaneKey.startsWith(`${SHARED_TAB_ID}:`)
      ) ?? false
    ).toBe(false)
    expect(persisted.ui?.acknowledgedAgentsByPaneKey).toHaveProperty('tab-shared:pane:1')
  })

  it('still bridges legacy pane keys when only one partition owns the tab id', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSessionsByHostId: {
        'ssh:host-a': makeLegacyPaneSession('repo-a', 'pty-a')
      }
    })

    const store = await createStore()
    store.flush()
    const persisted = readDataFile() as {
      legacyPaneKeyAliasEntries?: { legacyPaneKey: string }[]
    }

    expect(
      persisted.legacyPaneKeyAliasEntries?.some(
        (entry) => entry.legacyPaneKey === `${SHARED_TAB_ID}:1`
      )
    ).toBe(true)
  })
})
