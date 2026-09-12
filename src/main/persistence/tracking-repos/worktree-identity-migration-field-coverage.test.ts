/**
 * Every persisted session field that can name a worktree must lose the old identity when the
 * worktree is re-keyed.
 *
 * Driven by `WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND` rather than a list of its own: that table
 * is already a compile-error-to-skip census of how each field names an owner, and the migration
 * was the one path with no census at all. Three fields had fallen out of it —
 * `clientHostedBrowserPagesByWorktree` (key AND row `workspaceId`),
 * `closedTerminalTabTombstonesByTabId` and `clientHostedBrowserCloseIntentsByEnvironment` — each
 * one a row that keeps matching on an id nothing answers to any more.
 *
 * The oracle is `collectWorkspaceSessionWorktreeOwners`, the shipping collector, so a fixture
 * cannot be "the shape the assertion expects": it only counts as a reference if the collector
 * already reads it as one.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  collectWorkspaceSessionWorktreeOwners,
  WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND
} from '../restoring-sessions/session-worktree-ownership'
import { migrateWorktreeIdentity } from './worktree-identity-migration'

const REPO = 'repo'
const OLD = `${REPO}::/old/path`
const NEW = `${REPO}::/new/path`
const CANDIDATES = new Set([OLD, NEW])

type SessionField = keyof WorkspaceSessionState

/** One fixture per field, each holding exactly that field's reference to OLD. */
const REFERENCE_FIXTURES: Partial<Record<SessionField, Partial<WorkspaceSessionState>>> = {
  activeWorkspaceKey: { activeWorkspaceKey: worktreeWorkspaceKey(OLD) },
  activeWorktreeId: { activeWorktreeId: OLD },
  tabsByWorktree: {
    tabsByWorktree: {
      [OLD]: [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: OLD,
          title: 't',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  },
  activeWorktreeIdsOnShutdown: { activeWorktreeIdsOnShutdown: [OLD] },
  openFilesByWorktree: {
    openFilesByWorktree: {
      [OLD]: [
        {
          filePath: '/old/path/a.ts',
          relativePath: 'a.ts',
          worktreeId: OLD,
          language: 'ts',
          dirtyDraftContent: 'unsaved'
        }
      ]
    }
  },
  activeFileIdByWorktree: { activeFileIdByWorktree: { [OLD]: '/old/path/a.ts' } },
  browserTabsByWorktree: {
    browserTabsByWorktree: {
      [OLD]: [{ id: 'bw', worktreeId: OLD, title: 'b', createdAt: 1, activePageId: 'p' }] as never
    }
  },
  browserPagesByWorkspace: {
    browserPagesByWorkspace: {
      bw: [
        {
          id: 'p',
          workspaceId: 'bw',
          worktreeId: OLD,
          url: 'https://e.com',
          title: 'E',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ] as never
    }
  },
  activeBrowserTabIdByWorktree: { activeBrowserTabIdByWorktree: { [OLD]: 'bw' } },
  clientHostedBrowserPagesByWorktree: {
    clientHostedBrowserPagesByWorktree: {
      [OLD]: [
        {
          v: 1,
          browserPageId: 'chp',
          workspaceId: OLD,
          browserProfileId: 'profile',
          url: 'https://e.com',
          title: 'E',
          pairedDeviceId: 'device',
          savedAt: 1
        }
      ] as never
    }
  },
  clientHostedBrowserCloseIntentsByEnvironment: {
    clientHostedBrowserCloseIntentsByEnvironment: {
      'env-1': [{ browserPageId: 'chp', worktreeId: OLD, closedAt: 3 }]
    }
  },
  activeTabTypeByWorktree: { activeTabTypeByWorktree: { [OLD]: 'terminal' } },
  activeTabIdByWorktree: { activeTabIdByWorktree: { [OLD]: 'tab-1' } },
  unifiedTabs: {
    unifiedTabs: {
      [OLD]: [
        {
          id: 'tab-1',
          entityId: 'tab-1',
          groupId: 'g',
          worktreeId: OLD,
          contentType: 'terminal',
          label: 't',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ] as never
    }
  },
  tabGroups: {
    tabGroups: {
      [OLD]: [{ id: 'g', worktreeId: OLD, kind: 'terminal', sortOrder: 0, createdAt: 1 }] as never
    }
  },
  tabGroupLayouts: { tabGroupLayouts: { [OLD]: { type: 'leaf', groupId: 'g' } as never } },
  activeGroupIdByWorktree: { activeGroupIdByWorktree: { [OLD]: 'g' } },
  lastVisitedAtByWorktreeId: {
    lastVisitedAtByWorktreeId: { [OLD]: 10, [`ssh:target|${OLD}`]: 20 }
  },
  defaultTerminalTabsAppliedByWorktreeId: {
    defaultTerminalTabsAppliedByWorktreeId: { [OLD]: true }
  },
  sleepingAgentSessionsByPaneKey: {
    sleepingAgentSessionsByPaneKey: {
      'tab-1:leaf': {
        paneKey: 'tab-1:leaf',
        worktreeId: OLD,
        agent: 'claude',
        providerSession: {},
        prompt: 'p',
        state: 'idle',
        capturedAt: 1,
        updatedAt: 1
      } as never
    }
  },
  terminalSurfaceTombstonesByPaneKey: {
    terminalSurfaceTombstonesByPaneKey: {
      'tab-1:leaf': {
        worktreeId: OLD,
        parentTabId: 'tab-1',
        leafId: 'leaf',
        ptyId: 'pty',
        incarnationId: 'inc',
        retiredAt: 1
      }
    }
  },
  closedTerminalTabTombstonesByTabId: {
    closedTerminalTabTombstonesByTabId: { 'tab-1': { closedAt: 5, worktreeId: OLD } }
  }
}

function persistedState(session: WorkspaceSessionState): PersistedState {
  return {
    worktreeMeta: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    workspaceSession: session,
    workspaceSessionsByHostId: {}
  } as unknown as PersistedState
}

const referencingFields = (Object.keys(WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND) as SessionField[])
  .filter((field) => WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND[field] !== 'none')
  .sort()

describe('migrateWorktreeIdentity worktree-reference coverage', () => {
  it('has a fixture for every field the ownership census says can name a worktree', () => {
    const missing = referencingFields.filter((field) => !REFERENCE_FIXTURES[field])
    expect(missing).toEqual([])
  })

  for (const field of referencingFields) {
    it(`re-points ${field} off the old identity`, () => {
      const session: WorkspaceSessionState = {
        ...getDefaultWorkspaceSession(),
        ...REFERENCE_FIXTURES[field]
      }
      // The fixture is only a reference if the shipping collector reads it as one.
      expect([...collectWorkspaceSessionWorktreeOwners(session, CANDIDATES)]).toEqual([OLD])
      migrateWorktreeIdentity(persistedState(session), OLD, NEW)
      expect([...collectWorkspaceSessionWorktreeOwners(session, CANDIDATES)]).toEqual([NEW])
    })
  }

  // The collector reads this map by key only, so the row's own copy of the id needs its own check:
  // rehydration republishes a page only while `workspaceId` still equals the key it is filed under.
  it('re-points the workspaceId inside each client-hosted browser page row', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      ...REFERENCE_FIXTURES.clientHostedBrowserPagesByWorktree
    }
    migrateWorktreeIdentity(persistedState(session), OLD, NEW)
    expect(session.clientHostedBrowserPagesByWorktree?.[NEW]?.[0]?.workspaceId).toBe(NEW)
  })

  it('migrates host partitions, not just the local blob', () => {
    const hostSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      ...REFERENCE_FIXTURES.closedTerminalTabTombstonesByTabId
    }
    const state = persistedState(getDefaultWorkspaceSession())
    state.workspaceSessionsByHostId = { 'ssh:target': hostSession }
    expect(migrateWorktreeIdentity(state, OLD, NEW)).toBe(true)
    expect(hostSession.closedTerminalTabTombstonesByTabId?.['tab-1']?.worktreeId).toBe(NEW)
  })
})
