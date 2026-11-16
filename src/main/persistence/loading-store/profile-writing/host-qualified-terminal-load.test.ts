import {
  prepareOrcadMigrationWorkspaceSession,
  applyPreparedOrcadMigrationWorkspaceSession
} from '../../migrating-orcad-catalog/destination/orcad-destination-workspace-session'
import {
  prepareOrcadMigrationAutomationState,
  applyPreparedOrcadMigrationAutomationState
} from '../../migrating-orcad-catalog/destination/orcad-destination-automation-state'
import {
  DORMANT_AUTOMATION,
  DORMANT_AUTOMATION_RUN
} from '../../migrating-orcad-catalog/catalog-commit/persistence-orcad-migration-catalog-fixture'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson
} from '../../persistence-test-harness'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'
import { restoredPaneStartPlan } from '../../../runtime/terminal/recovery/restored-pane-start'
import { panesBoundToAnotherWorkspace } from '../../../runtime/terminal/recovery/foreign-pane-bindings'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('../store')
afterEach(() => {
  closeTestStores()
  vi.useRealTimers()
})

it('loads a newer local saved binding as the same physical terminal and saves the older-readable spelling', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
  const dataFile = join(
    realpathSync(mkdtempSync(join(tmpdir(), 'orca-host-id-reader-'))),
    'state.json'
  )
  const state = getDefaultPersistedState(tmpdir())
  const leaf = '10000000-0000-4000-8000-000000000001'
  state.workspaceSession = {
    ...state.workspaceSession,
    tabsByWorktree: {
      'repo::/a|b': [
        {
          id: 'tab',
          worktreeId: 'repo::/a|b',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: 'local|repo::/a|b@@saved'
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'local|repo::/a|b@@saved' }
      }
    },
    closedTerminalPanesByPaneKey: {
      closed: {
        ptyId: 'local|repo::/a|b@@closed',
        incarnationId: 'inc',
        worktreeId: 'repo::/a|b',
        closedAt: 1794787200000
      }
    },
    terminalSurfaceTombstonesByPaneKey: {
      retired: {
        ptyId: 'local|repo::/a|b@@retired',
        incarnationId: 'inc',
        worktreeId: 'repo::/a|b',
        parentTabId: 'tab',
        leafId: leaf,
        retiredAt: 1794787200000
      }
    }
  }
  state.workspaceSessionsByHostId = {
    'runtime:box': {
      ...state.workspaceSession,
      terminalLayoutsByTabId: {
        remote: {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'local|opaque-server-handle' }
        }
      }
    }
  }
  state.legacyPaneKeyAliasEntries = [
    {
      ptyId: 'local|repo::/a|b@@saved',
      legacyPaneKey: 'tab:1',
      stablePaneKey: 'tab:10000000-0000-4000-8000-000000000001',
      updatedAt: 1
    }
  ]
  state.automationRuns = [
    {
      id: 'run',
      automationId: 'automation',
      title: 'Run',
      scheduledFor: 1,
      status: 'dispatched',
      trigger: 'manual',
      workspaceId: 'repo::/a|b',
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: 'tab',
      terminalPaneKey: null,
      terminalPtyId: 'local|repo::/a|b@@saved',
      outputSnapshot: null,
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: 1,
      dispatchedAt: 1,
      createdAt: 1
    }
  ]
  writePersistedStateJson(dataFile, JSON.stringify(state))
  const store = createSqliteTestStore(Store, { dataFile })
  const session = store.getWorkspaceSession()
  expect(session.tabsByWorktree['repo::/a|b'][0].ptyId).toBe('repo::/a|b@@saved')
  expect(session.terminalLayoutsByTabId.tab.ptyIdsByLeafId).toEqual({ [leaf]: 'repo::/a|b@@saved' })
  expect(panesBoundToAnotherWorkspace(session)).toEqual([])
  expect(
    restoredPaneStartPlan(
      { worktreeId: 'repo::/a|b', tabId: 'tab', leafId: leaf },
      session.terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf] ?? null
    )
  ).toEqual({ sessionId: 'repo::/a|b@@saved' })
  store.flush()
  const saved = JSON.parse(readPersistedStateJson(dataFile))
  expect(saved.workspaceSession.tabsByWorktree['repo::/a|b'][0].ptyId).toBe('repo::/a|b@@saved')
  expect(saved.workspaceSession.closedTerminalPanesByPaneKey.closed.ptyId).toBe(
    'repo::/a|b@@closed'
  )
  expect(saved.workspaceSession.terminalSurfaceTombstonesByPaneKey.retired.ptyId).toBe(
    'repo::/a|b@@retired'
  )
  expect(
    saved.workspaceSessionsByHostId['runtime:box'].terminalLayoutsByTabId.remote.ptyIdsByLeafId[
      leaf
    ]
  ).toBe('local|opaque-server-handle')
  expect(saved.automationRuns[0].terminalPtyId).toBe('repo::/a|b@@saved')
  expect(saved.legacyPaneKeyAliasEntries[0].ptyId).toBe('repo::/a|b@@saved')
})

it('decodes saved catalog references before importing them into a running store', () => {
  const state = getDefaultPersistedState(tmpdir())
  const incoming = {
    ...state.workspaceSession,
    terminalSurfaceTombstonesByPaneKey: {
      retired: {
        ptyId: 'local|repo::/a@@retired',
        incarnationId: 'inc',
        worktreeId: 'repo::/a',
        parentTabId: 'tab',
        leafId: '10000000-0000-4000-8000-000000000001',
        retiredAt: 1
      }
    }
  }
  applyPreparedOrcadMigrationWorkspaceSession(
    prepareOrcadMigrationWorkspaceSession(incoming, state),
    state
  )
  applyPreparedOrcadMigrationAutomationState(
    prepareOrcadMigrationAutomationState(
      [DORMANT_AUTOMATION],
      [{ ...DORMANT_AUTOMATION_RUN, terminalPtyId: 'local|pty-history' }],
      state
    ),
    state
  )
  expect(state.workspaceSession.terminalSurfaceTombstonesByPaneKey?.retired.ptyId).toBe(
    'repo::/a@@retired'
  )
  expect(state.automationRuns[0].terminalPtyId).toBe('pty-history')
})
