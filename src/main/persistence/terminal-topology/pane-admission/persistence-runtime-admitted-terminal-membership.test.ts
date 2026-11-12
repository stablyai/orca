import { closeTestStores, createStore, testState } from '../../persistence-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { makeTerminalTab, TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo1::/worktree'

// Simulate a window snapshot that knows only its own tab.
function rendererSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    activeTabId: 'renderer-tab',
    tabsByWorktree: {
      [WORKTREE]: [
        makeTerminalTab({ id: 'renderer-tab', worktreeId: WORKTREE, ptyId: 'renderer-pty' })
      ]
    },
    terminalLayoutsByTabId: {
      'renderer-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'renderer-pty' }
      }
    }
  }
}

function persistedTabIds(session: WorkspaceSessionState, worktreeId: string): string[] {
  return (session.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
}

async function startRuntimePane(
  store: Awaited<ReturnType<typeof createStore>>,
  pane: { worktreeId: string; tabId: string; leafId: string; ptyId: string; incarnationId?: string }
): Promise<boolean> {
  expect(
    await store.admitTerminalPane({
      type: 'createTerminalTab',
      workspace: pane.worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId
    })
  ).toBe('admitted')
  return store.persistPtyBinding({ ...pane, mayCreate: false })
}

describe('runtime-admitted terminal membership survives a stale renderer replay', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-host-membership-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps the first runtime-admitted tab when the renderer replays its pre-create tab list', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    expect(
      await startRuntimePane(store, {
        worktreeId: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty'
      })
    ).toBe(true)
    const session = store.getWorkspaceSession()
    expect(persistedTabIds(session, WORKTREE)).toContain('host-tab')
    expect(session.unifiedTabs?.[WORKTREE]?.map((tab) => tab.entityId)).toContain('host-tab')
    expect(session.tabGroups?.[WORKTREE]?.flatMap((group) => group.tabOrder)).toContain('host-tab')
    expect(session.terminalLayoutsByTabId['host-tab']?.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_2]: 'host-pty'
    })

    // Replay the window’s debounced snapshot taken before runtime admission.
    store.setWorkspaceSession(rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toContain('host-tab')
  })

  // Authoritative retirement derives state from Store and must outrank the admission fence.

  it('refuses to bind a pane closed while its terminal started, and mints no tab for it', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())
    expect(
      await store.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2
      })
    ).toBe('admitted')
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: 'host-tab',
      leafId: TEST_LEAF_2
    })

    expect(
      await store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty',
        mayCreate: false
      })
    ).toBe(false)
    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toEqual(['renderer-tab'])
  })

  it('refuses to bind a split pane that moved to another tab while its terminal started', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())
    expect(
      await store.admitTerminalPane({
        type: 'splitPane',
        workspace: WORKTREE,
        tabId: 'renderer-tab',
        leafId: TEST_LEAF_1,
        direction: 'vertical',
        newLeafId: TEST_LEAF_2
      })
    ).toBe('admitted')
    await expect(
      store.moveTerminalLeafToNewTab({
        worktreeId: WORKTREE,
        sourceTabId: 'renderer-tab',
        targetTabId: 'moved-tab',
        leafId: TEST_LEAF_2,
        ptyId: null
      })
    ).resolves.toMatchObject({ status: 'moved' })

    expect(
      await store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: 'renderer-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'late-pty',
        mayCreate: false
      })
    ).toBe(false)
    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['renderer-tab']?.root).toEqual({
      type: 'leaf',
      leafId: TEST_LEAF_1
    })
    expect(
      session.terminalLayoutsByTabId['moved-tab']?.ptyIdsByLeafId?.[TEST_LEAF_2]
    ).toBeUndefined()
  })
})
