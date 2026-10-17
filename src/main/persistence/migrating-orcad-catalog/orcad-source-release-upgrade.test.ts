import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { PersistedOpenFile } from '../../../shared/workspace-session-state-types'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { createOrcadMigrationManifest } from '../../ssh/orcad-migration-manifest-export'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import { collectOrcadMigrationUntransferredDependencyCensus } from './orcad-source-dependency-census'
import { subtractOrcadMigrationSourceDormantState } from './orcad-source-dormant-subtraction'

const TARGET = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod',
  port: 22,
  username: 'u',
  generation: 1
}
const HOST = 'ssh:ssh-prod'
const WORKTREE = 'remote-repo::/srv/repo'
const LOCAL_WORKTREE = 'desktop-repo::/home/user/repo'

function terminal(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function resume(tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey: `${tabId}:leaf`,
    tabId,
    worktreeId: WORKTREE,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${tabId}` },
    prompt: 'Saved prompt',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: TARGET.id,
    origin: 'quit'
  }
}

function draft(): PersistedOpenFile {
  return {
    filePath: '/srv/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: WORKTREE,
    language: 'typescript',
    dirtyDraftContent: 'unsaved'
  }
}

function sourceState(): PersistedState {
  const state = getDefaultPersistedState('/home/user')
  state.sshTargets = [TARGET]
  state.repos = [
    {
      id: 'remote-repo',
      path: '/srv/repo',
      displayName: 'Remote',
      badgeColor: '#737373',
      addedAt: 1,
      connectionId: TARGET.id
    }
  ]
  state.workspaceSessionsByHostId = { [HOST]: getDefaultWorkspaceSession() }
  return state
}

function exportState(state: PersistedState) {
  return createOrcadMigrationManifest(
    {
      getRepos: () => state.repos,
      getFolderWorkspaces: () => state.folderWorkspaces,
      getProjectGroups: () => state.projectGroups,
      collectOrcadMigrationSourceDormantState: (source, catalog, destination) =>
        collectOrcadMigrationSourceDormantState(state, source, catalog, undefined, destination)
          .payload
    },
    TARGET,
    { destinationEnvironmentId: 'managed-prod' }
  )
}

function census(state: PersistedState) {
  return collectOrcadMigrationUntransferredDependencyCensus(state, exportState(state))
}

describe('migrating saved state from released SSH clients', () => {
  it('retains cross-host worktree and folder history on the desktop without blocking', () => {
    const state = sourceState()
    const lineage: WorktreeLineage = {
      worktreeId: WORKTREE,
      worktreeInstanceId: 'remote-instance',
      parentWorktreeId: LOCAL_WORKTREE,
      parentWorktreeInstanceId: 'desktop-instance',
      origin: 'cli' as const,
      capture: { source: 'cwd-context', confidence: 'inferred' as const },
      createdAt: 1
    }
    state.worktreeLineageById[WORKTREE] = lineage
    const child = worktreeWorkspaceKey(WORKTREE)
    state.workspaceLineageByChildKey[child] = {
      childWorkspaceKey: child,
      childInstanceId: 'remote-instance',
      parentWorkspaceKey: 'folder:desktop-folder',
      parentInstanceId: null,
      origin: 'cli',
      capture: lineage.capture,
      createdAt: 1
    }
    state.worktreeLineageById[LOCAL_WORKTREE] = {
      ...lineage,
      worktreeId: LOCAL_WORKTREE,
      parentWorktreeId: WORKTREE
    }
    const before = structuredClone(state)
    const manifest = exportState(state)
    expect(census(state).totalCount).toBe(0)
    expect(manifest.payload.dormantState?.worktreeLineage ?? []).toEqual([])
    expect(manifest.payload.dormantState?.workspaceLineage ?? []).toEqual([])
    subtractOrcadMigrationSourceDormantState(state, manifest)
    expect(state.worktreeLineageById).toEqual(before.worktreeLineageById)
    expect(state.workspaceLineageByChildKey).toEqual(before.workspaceLineageByChildKey)
  })

  it('retains closed-pane resume records without restoring their deleted tabs', () => {
    const state = sourceState()
    const host = state.workspaceSessionsByHostId![HOST]!
    host.sleepingAgentSessionsByPaneKey = { 'closed:leaf': resume('closed') }
    const before = structuredClone(state)
    expect(census(state).totalCount).toBe(0)
    expect(exportState(state).payload.dormantState?.workspaceSession).toBeUndefined()
    expect(state).toEqual(before)
  })

  it('still refuses a resume record with a missing leaf in an existing tab', () => {
    const state = sourceState()
    const host = state.workspaceSessionsByHostId![HOST]!
    host.tabsByWorktree = { [WORKTREE]: [terminal('open')] }
    host.terminalLayoutsByTabId = {
      open: { root: { type: 'leaf', leafId: 'other' }, activeLeafId: 'other', expandedLeafId: null }
    }
    host.sleepingAgentSessionsByPaneKey = { 'open:leaf': resume('open') }
    expect(census(state).counts['workspace-session']).toBe(1)
  })

  it('still refuses an orphan carrying a worker resume fence', () => {
    const state = sourceState()
    const record = { ...resume('closed'), automaticResumeBlockedBy: 'worker-owner' }
    state.workspaceSessionsByHostId![HOST]!.sleepingAgentSessionsByPaneKey = {
      [record.paneKey]: record
    }
    expect(census(state).counts['workspace-session']).toBe(1)
  })

  it('does not let a newer host snapshot hide a worker fence in the local copy', () => {
    const state = sourceState()
    const record = { ...resume('open'), automaticResumeBlockedBy: 'worker-owner' }
    state.workspaceSession.tabsByWorktree = { [WORKTREE]: [terminal('open')] }
    state.workspaceSession.sleepingAgentSessionsByPaneKey = { [record.paneKey]: record }
    state.workspaceSessionsByHostId![HOST]!.tabsByWorktree = { [WORKTREE]: [terminal('open')] }
    expect(census(state).counts['workspace-session']).toBe(1)
  })

  it('exports the host-owned tabs and scrollback once, retaining the older local copy', () => {
    const state = sourceState()
    const host = state.workspaceSessionsByHostId![HOST]!
    host.tabsByWorktree = { [WORKTREE]: [terminal('shared'), terminal('new')] }
    host.terminalLayoutsByTabId = {
      shared: {
        root: { type: 'leaf', leafId: 'leaf' },
        activeLeafId: 'leaf',
        expandedLeafId: null,
        buffersByLeafId: { leaf: 'shared output' }
      }
    }
    state.workspaceSession.tabsByWorktree = {
      [WORKTREE]: [{ ...terminal('shared'), title: 'Old title' }]
    }
    state.workspaceSession.terminalLayoutsByTabId = structuredClone(host.terminalLayoutsByTabId)
    host.terminalTopologyRevisionByRepoId = { 'remote-repo': 9 }
    state.workspaceSession.terminalTopologyRevisionByRepoId = { 'remote-repo': 2 }
    state.workspaceSession.tabsByWorktree['remote-repo::/srv/legacy-only'] = [
      { ...terminal('legacy-only'), worktreeId: 'remote-repo::/srv/legacy-only' }
    ]
    const before = structuredClone(state)
    expect(census(state).totalCount).toBe(0)
    const dormant = exportState(state).payload.dormantState
    expect(dormant?.workspaceSession?.tabsByWorktree[WORKTREE]).toEqual(
      host.tabsByWorktree[WORKTREE]
    )
    expect(
      dormant?.workspaceSession?.tabsByWorktree['remote-repo::/srv/legacy-only']?.[0]?.id
    ).toBe('legacy-only')
    expect(dormant?.terminalScrollbackSnapshots).toHaveLength(1)
    expect(dormant?.workspaceSession?.terminalTopologyRevisionByRepoId).toEqual({
      'remote-repo': 9
    })
    expect(state).toEqual(before)
  })

  it('never gives a different host authority over the source session', () => {
    const state = sourceState()
    state.workspaceSession.tabsByWorktree = { [WORKTREE]: [terminal('source')] }
    state.workspaceSessionsByHostId!['ssh:other'] = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE]: [terminal('other')] }
    }
    expect(
      exportState(state).payload.dormantState?.workspaceSession?.tabsByWorktree[WORKTREE]?.[0]?.id
    ).toBe('source')
  })

  // Shipped builds split one SSH workspace across the local and host copies (#12723).
  describe('when the local and host copies both hold the workspace', () => {
    function split() {
      const state = sourceState()
      return { state, local: state.workspaceSession, host: state.workspaceSessionsByHostId![HOST]! }
    }

    it('exports local tabs when the host holds only a recency stamp', () => {
      const { state, local, host } = split()
      host.lastVisitedAtByWorktreeId = { [WORKTREE]: 5 }
      local.tabsByWorktree = { [WORKTREE]: [terminal('local')] }
      local.explicitlySleptChatsByWorkspace = {
        [`${HOST}|${WORKTREE}`]: [{ tabId: 'chat', sessionId: 'session' }]
      }
      expect(census(state).totalCount).toBe(0)
      const session = exportState(state).payload.dormantState?.workspaceSession
      expect(session?.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['local'])
      expect(session).not.toHaveProperty('explicitlySleptChatsByWorkspace')
    })

    it('exports local tabs and drafts beside a host-only closed-pane resume record', () => {
      const { state, local, host } = split()
      host.sleepingAgentSessionsByPaneKey = { 'closed:leaf': resume('closed') }
      local.tabsByWorktree = { [WORKTREE]: [terminal('local')] }
      local.openFilesByWorktree = { [WORKTREE]: [draft()] }
      expect(census(state).totalCount).toBe(0)
      const session = exportState(state).payload.dormantState?.workspaceSession
      expect(session?.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['local'])
      expect(session?.openFilesByWorktree?.[WORKTREE]).toEqual([draft()])
      expect(session?.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
    })

    it('refuses a host resume record for a tab only the local copy lists', () => {
      const { state, local, host } = split()
      host.sleepingAgentSessionsByPaneKey = { 'local:leaf': resume('local') }
      local.tabsByWorktree = { [WORKTREE]: [terminal('local')] }
      expect(census(state).counts['workspace-session']).toBe(1)
    })

    // #27281: the app shows the local tabs here, because an empty row is not a close.
    it('exports the local tabs when the host holds an empty tab list', () => {
      const { state, local, host } = split()
      host.tabsByWorktree = { [WORKTREE]: [] }
      local.tabsByWorktree = { [WORKTREE]: [terminal('local')] }
      expect(census(state).totalCount).toBe(0)
      const session = exportState(state).payload.dormantState?.workspaceSession
      expect(session?.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['local'])
    })

    it('refuses an empty host row beside local tabs the host recorded as closed', () => {
      const { state, local, host } = split()
      host.tabsByWorktree = { [WORKTREE]: [] }
      host.closedTerminalTabTombstonesByTabId = {
        local: { worktreeId: WORKTREE, reason: 'user', closedAt: Date.now() }
      }
      local.tabsByWorktree = { [WORKTREE]: [terminal('local')] }
      expect(census(state).counts['workspace-session']).toBe(1)
    })

    it('keeps a local unsaved draft when the host tabs supersede the local copy', () => {
      const { state, local, host } = split()
      host.tabsByWorktree = { [WORKTREE]: [terminal('host')] }
      local.tabsByWorktree = { [WORKTREE]: [terminal('host')] }
      local.openFilesByWorktree = { [WORKTREE]: [draft()] }
      expect(census(state).totalCount).toBe(0)
      const session = exportState(state).payload.dormantState?.workspaceSession
      expect(session?.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['host'])
      expect(session?.openFilesByWorktree?.[WORKTREE]).toEqual([draft()])
    })

    it('refuses when the host holds a different copy of the file with the local draft', () => {
      const { state, local, host } = split()
      host.tabsByWorktree = { [WORKTREE]: [terminal('host')] }
      host.openFilesByWorktree = { [WORKTREE]: [{ ...draft(), dirtyDraftContent: 'other' }] }
      local.openFilesByWorktree = { [WORKTREE]: [draft()] }
      expect(census(state).counts['workspace-session']).toBe(1)
    })

    it('never brings back a tab the local copy recorded as closed', () => {
      const { state, local, host } = split()
      host.tabsByWorktree = { [WORKTREE]: [terminal('closed-tab')] }
      local.tabsByWorktree = { [WORKTREE]: [] }
      local.closedTerminalTabTombstonesByTabId = {
        'closed-tab': { worktreeId: WORKTREE, reason: 'user', closedAt: Date.now() }
      }
      expect(census(state).counts['workspace-session']).toBe(1)
      expect(exportState(state).payload.dormantState?.workspaceSession).toBeUndefined()
    })
  })
})
