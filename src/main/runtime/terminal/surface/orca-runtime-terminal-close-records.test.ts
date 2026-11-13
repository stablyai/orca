import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { Store } from '../../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  LEAF_ID,
  REPO_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { advanceTerminalTopologyRevision } from '../../../persistence/terminal-topology/pane-ownership/terminal-topology-membership'

const SSH_REPO_ID = 'ssh-repo'
const SSH_HOST_ID = 'ssh:target-1'
const SSH_WORKTREE_ID = `${SSH_REPO_ID}::/srv/app`
const LATE_TAB_ID = '6f0a5c8e-2b1d-4c3e-9f7a-1d2e3f4a5b6c'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createPersistedRuntime(session: WorkspaceSessionState = makeSession()) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-close-records-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: SSH_REPO_ID,
    path: '/srv/app',
    displayName: 'Remote',
    badgeColor: 'gray',
    addedAt: 1,
    connectionId: 'target-1'
  })
  store.setWorkspaceSession(advanceTerminalTopologyRevision(session, WORKTREE_ID))
  store.flushOrThrow()
  return {
    store,
    runtime: new OrcaRuntimeService(store),
    reload: async () => {
      store.flush()
      store.freezeWrites()
      await store.waitForPendingWrite()
      return createSqliteTestStore(Store, { dataFile })
    }
  }
}

/** Renderer saves membership, never main-owned close records. */
function rendererSave(session: WorkspaceSessionState): WorkspaceSessionState {
  const {
    terminalTopologyRevisionByRepoId: _hostPrivate,
    closedTerminalTabTombstonesByTabId: _mainOwned,
    ...rendererView
  } = session
  return { ...rendererView, tabsByWorktree: { [WORKTREE_ID]: [] }, terminalLayoutsByTabId: {} }
}

describe('close records', () => {
  it.each(['user', 'cleanup'] as const)(
    'records a %s close in main and keeps it across a renderer save and a reload',
    async (reason) => {
      const { store, runtime, reload } = createPersistedRuntime()

      await runtime.closeTerminalSurfaceFromRenderer({
        worktreeId: WORKTREE_ID,
        target: { kind: 'tab', tabId: TAB_ID },
        reason
      })
      store.setWorkspaceSession(rendererSave(store.getWorkspaceSession()))

      const reloaded = (await reload()).getWorkspaceSession()
      expect(reloaded.tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(reloaded.closedTerminalTabTombstonesByTabId?.[TAB_ID]).toEqual({
        closedAt: expect.any(Number),
        worktreeId: WORKTREE_ID,
        reason
      })
    }
  )

  // Durable close must reject in-flight spawns committing after crash/reload, even if the tab was never listed.
  it('refuses a closed tab whose spawn commits after a crash and reload', async () => {
    const { runtime, reload } = createPersistedRuntime()

    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: LATE_TAB_ID }
    })
    const relaunched = await reload()

    expect(
      await relaunched.persistPtyBinding({
        worktreeId: WORKTREE_ID,
        tabId: LATE_TAB_ID,
        leafId: LEAF_ID,
        ptyId: 'late-pty',
        incarnationId: 'late-incarnation'
      })
    ).toBe(false)
    expect(
      relaunched.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)
    ).not.toContain(LATE_TAB_ID)
  })

  it('refuses the graft when the close was recorded in another host partition', async () => {
    const { store, runtime } = createPersistedRuntime()
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), tabsByWorktree: { [SSH_WORKTREE_ID]: [] } },
      SSH_HOST_ID
    )

    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: SSH_WORKTREE_ID,
      target: {
        kind: 'tab',
        tabId: LATE_TAB_ID
      }
    })

    expect(
      store.getWorkspaceSession(SSH_HOST_ID).closedTerminalTabTombstonesByTabId?.[LATE_TAB_ID]
    ).toBeDefined()
    // Reattach targets local, distinct from the partition recording close.
    expect(
      await store.persistPtyBinding({
        worktreeId: SSH_WORKTREE_ID,
        tabId: LATE_TAB_ID,
        leafId: LEAF_ID,
        ptyId: 'ssh:target-1@@pty2:epoch:1',
        incarnationId: 'relay-incarnation'
      })
    ).toBe(false)
  })
})
