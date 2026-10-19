import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { Store } from './loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  REPO_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from '../runtime/__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { advanceTerminalTopologyRevision } from './terminal-topology/terminal-topology-membership'

const SSH_HOST_ID = 'ssh:target-1'
const SSH_WORKTREE_ID = 'ssh-repo::/srv/app'
const OTHER_TAB_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createPersistedStore() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-closed-tab-fence-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'L',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'ssh-repo',
    path: '/srv/app',
    displayName: 'R',
    badgeColor: 'gray',
    addedAt: 1,
    connectionId: 'target-1'
  })
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

/** A session holding TAB_ID (and OTHER_TAB_ID) for one worktree, with its unified tab and group. */
function sessionFor(worktreeId: string): WorkspaceSessionState {
  const base = makeSession()
  const rows = base.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({ ...tab, worktreeId }))
  const unified = (id: string, sortOrder: number) => ({
    id,
    entityId: id,
    groupId: 'group',
    worktreeId,
    contentType: 'terminal' as const,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  })
  return {
    ...base,
    tabsByWorktree: { [worktreeId]: [...rows, { ...rows[0]!, id: OTHER_TAB_ID, sortOrder: 1 }] },
    unifiedTabs: { [worktreeId]: [unified(TAB_ID, 0), unified(OTHER_TAB_ID, 1)] },
    tabGroups: {
      [worktreeId]: [
        { id: 'group', worktreeId, activeTabId: TAB_ID, tabOrder: [TAB_ID, OTHER_TAB_ID] }
      ]
    },
    activeTabIdByWorktree: { [worktreeId]: TAB_ID }
  }
}

describe('a write cannot bring back a tab its partition recorded as closed (#12447)', () => {
  // The close lands before the renderer save that first lists the tab, so no topology revision
  // fences that save: only the close record can refuse it.
  it.each([
    ['local', undefined, WORKTREE_ID],
    ['SSH', SSH_HOST_ID, SSH_WORKTREE_ID]
  ] as const)(
    'drops a closed tab a late %s renderer save still lists',
    async (_label, hostId, worktreeId) => {
      const { store, runtime, reload } = createPersistedStore()
      store.setWorkspaceSession(
        { ...getDefaultWorkspaceSession(), tabsByWorktree: { [worktreeId]: [] } },
        hostId
      )

      await runtime.closeTerminalSurfaceFromRenderer({
        worktreeId,
        target: { kind: 'tab', tabId: TAB_ID }
      })
      store.setWorkspaceSession(sessionFor(worktreeId), hostId)

      const after = (await reload()).getWorkspaceSession(hostId)
      expect(after.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([OTHER_TAB_ID])
      expect(after.terminalLayoutsByTabId[TAB_ID]).toBeUndefined()
      expect(after.unifiedTabs?.[worktreeId]?.map((tab) => tab.id)).toEqual([OTHER_TAB_ID])
      expect(after.tabGroups?.[worktreeId]?.[0]?.tabOrder).toEqual([OTHER_TAB_ID])
      expect(after.closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeDefined()
    }
  )

  it('drops the closed tab from a unified-tabs-only patch', async () => {
    const { store, runtime } = createPersistedStore()
    const before = advanceTerminalTopologyRevision(sessionFor(WORKTREE_ID), WORKTREE_ID)
    store.setWorkspaceSession(before)
    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: TAB_ID }
    })

    store.patchWorkspaceSession({ unifiedTabs: before.unifiedTabs })

    expect(store.getWorkspaceSession().unifiedTabs?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      OTHER_TAB_ID
    ])
  })

  it('keeps a same-id tab under another worktree than the one the record names', async () => {
    const { store } = createPersistedStore()
    const session = sessionFor(WORKTREE_ID)
    store.setWorkspaceSession({
      ...session,
      closedTerminalTabTombstonesByTabId: {
        [TAB_ID]: { closedAt: Date.now(), worktreeId: 'repo::/elsewhere', reason: 'user' }
      }
    })

    expect(store.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      TAB_ID,
      OTHER_TAB_ID
    ])
  })

  // A host slice with no terminal rows omits the terminal maps altogether.
  it.each(['set', 'stage-before-unload'] as const)(
    'accepts a browser-only host slice once the partition has a close record (%s)',
    async (write) => {
      const { store, runtime } = createPersistedStore()
      store.setWorkspaceSession(
        { ...getDefaultWorkspaceSession(), tabsByWorktree: { [SSH_WORKTREE_ID]: [] } },
        SSH_HOST_ID
      )
      await runtime.closeTerminalSurfaceFromRenderer({
        worktreeId: SSH_WORKTREE_ID,
        target: { kind: 'tab', tabId: TAB_ID }
      })
      const {
        tabsByWorktree: _omitted,
        terminalLayoutsByTabId: _alsoOmitted,
        ...slice
      } = { ...getDefaultWorkspaceSession(), activeWorktreeId: SSH_WORKTREE_ID }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models the renderer's host split, which omits empty terminal maps from its IPC payload.
      const sparse = slice as WorkspaceSessionState

      if (write === 'set') {
        store.setWorkspaceSession(sparse, SSH_HOST_ID)
      } else {
        store.stageWorkspaceSessionBeforeUnload(sparse, SSH_HOST_ID)
      }

      const after = store.getWorkspaceSession(SSH_HOST_ID)
      expect(after.activeWorktreeId).toBe(SSH_WORKTREE_ID)
      expect(after.closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeDefined()
    }
  )
})
