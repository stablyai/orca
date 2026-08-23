import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './runtime/mobile-session-terminal-persistence-retirement'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'
import { createStore, makeTerminalTab, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo1::/worktree'
const OTHER_WORKTREE = 'repo1::/other-worktree'

/** The renderer's own publication: it knows only about the tab it created. */
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

describe('host-admitted terminal membership survives a stale renderer replay', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-host-membership-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps the first host-admitted tab when the renderer replays its pre-create tab list', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    // `orca terminal create`: the host mints a tab the renderer has never seen.
    expect(
      store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty',
        hostAdmittedMembership: true
      })
    ).toBe(true)
    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toContain('host-tab')

    // The renderer's debounced writer flushes a snapshot taken before the create.
    store.setWorkspaceSession(rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toContain('host-tab')
  })

  it('keeps a host-admitted tab in a second worktree of the same repo', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    store.persistPtyBinding({
      worktreeId: OTHER_WORKTREE,
      tabId: 'host-tab-other',
      leafId: TEST_LEAF_2,
      ptyId: 'host-pty-other',
      hostAdmittedMembership: true
    })
    store.setWorkspaceSession(rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), OTHER_WORKTREE)).toContain('host-tab-other')
  })

  // Polarity: without the flag the renderer still owns membership, so a renderer
  // spawn racing its own writer must not freeze the tab list.
  it('leaves renderer-owned membership alone when the binding is not host-admitted', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: 'renderer-second-tab',
      leafId: TEST_LEAF_2,
      ptyId: 'renderer-second-pty'
    })
    store.setWorkspaceSession(rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toEqual(['renderer-tab'])
  })

  // Closing must still work afterwards. Closes are host-driven: the retirement is
  // computed from the store's own session (see persistTerminalSurfaceRetirements),
  // which is what outranks the fence this create just raised.
  it('still lets the authoritative retirement path close the host-admitted tab', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())
    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: 'host-tab',
      leafId: TEST_LEAF_2,
      ptyId: 'host-pty',
      incarnationId: 'host-incarnation',
      hostAdmittedMembership: true
    })

    store.setWorkspaceSession(
      retireTerminalSurfaceFromPersistence(store.getWorkspaceSession(), {
        worktreeId: WORKTREE,
        parentTabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty',
        incarnationId: 'host-incarnation'
      })
    )
    // A stale renderer replay must not resurrect it either.
    store.setWorkspaceSession(rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toEqual(['renderer-tab'])
  })
})
