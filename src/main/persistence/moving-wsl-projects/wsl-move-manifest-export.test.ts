import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import {
  DORMANT_AUTOMATION,
  DORMANT_AUTOMATION_RUN
} from '../migrating-orcad-catalog/persistence-orcad-migration-catalog-fixture'
import { createOrcadMigrationSourceScope } from '../migrating-orcad-catalog/orcad-source-scope'
import { collectOrcadMigrationSourceDormantState } from '../migrating-orcad-catalog/orcad-source-dormant-state'
import {
  exportWslMoveManifest,
  WslMoveScopeChangedError,
  type WslMoveManifestExportRequest,
  type WslMoveManifestExportStore
} from './wsl-move-manifest-export'

const DISTRO = 'Ubuntu'
const UNC_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app'
const UNC_WORKTREE = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app-feature'
const WORKTREE = `app::${UNC_WORKTREE}`
const OTHER_WORKTREE = 'win::C:\\code\\win'

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  return { id, path, displayName: id, badgeColor: '#737373', addedAt: 1, ...extra }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    startupCwd: worktreeId.split('::')[1]
  }
}

function sourceState(): PersistedState {
  const state = getDefaultPersistedState('C:\\Users\\me')
  state.repos = [
    repo('app', UNC_REPO),
    repo('win', 'C:\\code\\win'),
    repo('elsewhere', '\\\\wsl.localhost\\Debian\\home\\me\\other')
  ]
  state.worktreeMeta[WORKTREE] = {
    displayName: 'Feature',
    comment: 'keep',
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: true,
    sortOrder: 1,
    lastActivityAt: 2
  }
  state.worktreeMeta[OTHER_WORKTREE] = { ...state.worktreeMeta[WORKTREE], displayName: 'Windows' }
  state.automations = [
    {
      ...DORMANT_AUTOMATION,
      id: 'automation-app',
      enabled: true,
      projectId: 'app',
      runContext: {
        ...DORMANT_AUTOMATION.runContext!,
        repoId: 'app',
        projectHostSetupId: 'app',
        path: UNC_REPO
      },
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service'
    },
    {
      ...DORMANT_AUTOMATION,
      id: 'automation-win',
      enabled: true,
      projectId: 'win',
      runContext: {
        ...DORMANT_AUTOMATION.runContext!,
        repoId: 'win',
        projectHostSetupId: 'win',
        path: 'C:\\code\\win'
      },
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service'
    }
  ]
  state.automationRuns = [
    {
      ...DORMANT_AUTOMATION_RUN,
      automationId: 'automation-app',
      runContext: state.automations[0]!.runContext
    }
  ]
  state.workspaceSession = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [tab('feature-shell', WORKTREE)],
      [OTHER_WORKTREE]: [tab('windows-shell', OTHER_WORKTREE)]
    }
  }
  return state
}

function storeFor(state: PersistedState): WslMoveManifestExportStore {
  return {
    getRepos: () => state.repos,
    getFolderWorkspaces: () => state.folderWorkspaces,
    getProjectGroups: () => state.projectGroups,
    inspectOrcadMigrationSourceDormantState: (source, catalog, destination) =>
      collectOrcadMigrationSourceDormantState(state, source, catalog, undefined, destination)
  }
}

const REQUEST: WslMoveManifestExportRequest = {
  migrationId: 'move-1',
  now: () => new Date('2026-10-20T00:00:00.000Z'),
  distro: DISTRO,
  distroGuid: '{guid}',
  destinationEnvironmentId: 'wsl:Ubuntu',
  generation: 2,
  repoIds: ['app'],
  folderWorkspaceIds: []
}

describe('exportWslMoveManifest', () => {
  it('signs what the host and the journal will read, even with in-memory dates', () => {
    // A row added this session can still hold a Date the next load would read back as a string. The
    // signature covered "{}" for it while the host hashed the string, so the first move after adding
    // a project reset with a digest mismatch until a restart.
    const state = sourceState()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the in-memory shape the load normalizes.
    ;(state.repos[0] as unknown as Record<string, unknown>).lastSeenAt = new Date(
      '2026-10-20T00:00:00.000Z'
    )
    const { manifest } = exportWslMoveManifest(storeFor(state), REQUEST)
    expect(() =>
      assertOrcadMigrationManifestDigest(JSON.parse(JSON.stringify(manifest)))
    ).not.toThrow()
  })

  it("shares no object with the live state, so a later sleep can't change what was signed", () => {
    const state = sourceState()
    const { manifest } = exportWslMoveManifest(storeFor(state), REQUEST)
    // Sleep and the session freeze mutate the live session after the export signs it.
    for (const tabs of Object.values(state.workspaceSession.tabsByWorktree)) {
      for (const tab of tabs) {
        tab.title = 'renamed by sleep'
      }
    }
    expect(() =>
      assertOrcadMigrationManifestDigest(JSON.parse(JSON.stringify(manifest)))
    ).not.toThrow()
  })

  describe('only the selected projects can refuse it', () => {
    const agentIn = (
      worktreeId: string,
      tabId: string,
      leafId: string
    ): SleepingAgentSessionRecord => ({
      paneKey: `${tabId}:${leafId}`,
      tabId,
      worktreeId,
      agent: 'codex',
      providerSession: { key: 'session_id', id: `session-${tabId}` },
      prompt: 'Saved prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      connectionId: null,
      origin: 'live'
    })
    const layout = (leafId: string) => ({
      root: { type: 'leaf' as const, leafId },
      activeLeafId: leafId,
      expandedLeafId: null
    })

    it('is still refused by the same kinds of state in the selected project', () => {
      const state = sourceState()
      const own = agentIn(WORKTREE, 'feature-shell', 'feature-leaf')
      state.workspaceSession.terminalLayoutsByTabId = { 'feature-shell': layout('elsewhere') }
      state.workspaceSession.sleepingAgentSessionsByPaneKey = { [own.paneKey]: own }
      state.workspaceSession.openFilesByWorktree = {
        [WORKTREE]: [
          {
            filePath: '/home/me/app-feature/notes.md',
            relativePath: 'notes.md',
            worktreeId: WORKTREE,
            language: 'markdown',
            dirtyDraftContent: 'unsaved',
            runtimeEnvironmentId: 'some-other-server'
          }
        ]
      }
      const { blockers } = exportWslMoveManifest(storeFor(state), REQUEST)
      expect(blockers).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/codex session saved in/),
          expect.stringMatching(/unsaved changes to/)
        ])
      )
    })

    it('never silently leaves behind an agent whose key may be the selected project', () => {
      // `app` is also registered by an SSH host, so an unqualified `app::` key names either.
      const state = sourceState()
      state.repos.push(repo('app', '/srv/app', { connectionId: 'box' }))
      const own = agentIn(WORKTREE, 'feature-shell', 'feature-leaf')
      state.workspaceSession.terminalLayoutsByTabId = { 'feature-shell': layout('elsewhere') }
      state.workspaceSession.sleepingAgentSessionsByPaneKey = { [own.paneKey]: own }
      expect(exportWslMoveManifest(storeFor(state), REQUEST).blockers).toEqual([
        expect.stringMatching(/codex session saved in/)
      ])
    })
  })

  it('signs the session as the host parses it, even with a field the parser drops', () => {
    // On a real host, a move right after sleeping terminals reset with a digest mismatch, because the
    // signature covered session fields the manifest parser does not keep.
    const state = sourceState()
    const sleptTab: Record<string, unknown> = {
      ...state.workspaceSession.tabsByWorktree[WORKTREE]![0]
    }
    sleptTab.fieldNoParserKeeps = 1
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an extra field on a real tab.
    state.workspaceSession.tabsByWorktree[WORKTREE] = [sleptTab as unknown as TerminalTab]
    const { manifest } = exportWslMoveManifest(storeFor(state), REQUEST)
    expect(() =>
      assertOrcadMigrationManifestDigest(JSON.parse(JSON.stringify(manifest)))
    ).not.toThrow()
  })

  it('carries no desktop PTY binding, so the moved pane reads its history from the host', () => {
    // The host's session kept the desktop's PTY ids, so the client took each pane
    // for a live terminal, skipped the scrollback read, and opened a fresh prompt.
    const state = sourceState()
    const leaf = '11111111-1111-4111-8111-111111111111'
    const tab = state.workspaceSession.tabsByWorktree[WORKTREE]![0]!
    state.workspaceSession.tabsByWorktree[WORKTREE] = [{ ...tab, ptyId: `${WORKTREE}@@81c7100a` }]
    state.workspaceSession.terminalLayoutsByTabId = {
      [tab.id]: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: `${WORKTREE}@@81c7100a` },
        buffersByLeafId: { [leaf]: 'history' }
      }
    }
    const { manifest } = exportWslMoveManifest(storeFor(state), REQUEST)
    const session = manifest.payload.dormantState?.workspaceSession
    const layout = Object.values(session?.terminalLayoutsByTabId ?? {})[0]
    expect(layout?.scrollbackRefsByLeafId?.[leaf]).toBeTruthy()
    expect(layout).not.toHaveProperty('ptyIdsByLeafId')
    expect(Object.values(session?.tabsByWorktree ?? {}).flat()[0]?.ptyId).toBeNull()
  })

  it('refuses to sign a scope naming a project that is no longer here', () => {
    expect(() =>
      exportWslMoveManifest(storeFor(sourceState()), { ...REQUEST, repoIds: ['app', 'gone'] })
    ).toThrow(WslMoveScopeChangedError)
  })

  it('still keeps the SSH conversion steps from accepting a WSL manifest', () => {
    const { manifest } = exportWslMoveManifest(storeFor(sourceState()), REQUEST)
    expect(() =>
      createOrcadMigrationSourceScope({
        source: manifest.source,
        catalog: manifest.payload,
        repos: []
      })
    ).toThrow('orcad_migration_source_not_ssh')
  })
})
