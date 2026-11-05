// Drive migration coverage from the exhaustive ownership census and verify references with the shipping collector.
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'

import { migrateWorktreeIdentity } from './worktree-identity-migration'

const REPO = 'repo'
const OLD = `${REPO}::/old/path`
const NEW = `${REPO}::/new/path`

type SessionField = keyof WorkspaceSessionState

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
      [OLD]: [
        {
          id: 'bw',
          worktreeId: OLD,
          activePageId: 'p',
          url: 'https://e.com',
          title: 'b',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
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
      ]
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
      ]
    }
  },
  clientHostedBrowserCloseIntentsByEnvironment: {
    clientHostedBrowserCloseIntentsByEnvironment: {
      'env-1': [{ browserPageId: 'chp', worktreeId: OLD, closedAt: 3 }]
    }
  },
  pairedTerminalTabCloseIntentsByEnvironment: {
    pairedTerminalTabCloseIntentsByEnvironment: {
      'env-1': [{ hostTabIds: ['host-tab'], worktreeId: OLD, closedAt: 3, pairingRevision: 1 }]
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
      ]
    }
  },
  tabGroups: {
    tabGroups: {
      [OLD]: [{ id: 'g', worktreeId: OLD, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
    }
  },
  tabGroupLayouts: { tabGroupLayouts: { [OLD]: { type: 'leaf', groupId: 'g' } } },
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
        providerSession: { key: 'session_id', id: 'session-1' },
        prompt: 'p',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      }
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
  },
  closedTerminalPanesByPaneKey: {
    closedTerminalPanesByPaneKey: {
      'tab-1:leaf': { ptyId: 'pty-1', incarnationId: 'inc-1', worktreeId: OLD, closedAt: 5 }
    }
  }
}

function persistedState(session: WorkspaceSessionState): PersistedState {
  return { ...getDefaultPersistedState('/home/test'), workspaceSession: session }
}

// Narrow Object.keys strings to census fields without widening fixture indexing.

describe('migrateWorktreeIdentity worktree-reference coverage', () => {
  // Collector checks keys only; rehydration also requires each row's workspaceId to match.
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
