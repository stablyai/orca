import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type { TerminalTab, TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const LOCAL_WORKTREE_ID = 'repo-local::/fixture/local'
const REMOTE_WORKTREE_ID = 'repo-remote::/fixture/remote'
const LOCAL_TAB_ID = 'tab-local'
const REMOTE_TAB_ID = 'tab-remote'
const LOCAL_LEAF_ID = 'leaf-local'
const REMOTE_LEAF_ID = 'leaf-remote'
const REMOTE_HOST_ID = 'ssh:build-host'

export type ProfileStateCutoverFixture = PersistedState & {
  futureTopLevelExtension: {
    keep: string
    nullable: null
  }
}

function fixtureRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-local',
    path: '/fixture/local',
    displayName: 'Fixture local',
    badgeColor: '#737373',
    addedAt: 1,
    ...overrides
  }
}

function fixtureProject(overrides: Partial<Project>): Project {
  return {
    id: 'project-fixture',
    displayName: 'Fixture project',
    badgeColor: '#737373',
    sourceRepoIds: ['repo-local', 'repo-remote'],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

function fixtureSetup(overrides: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: 'setup-local',
    projectId: 'project-fixture',
    hostId: 'local',
    repoId: 'repo-local',
    path: '/fixture/local',
    displayName: 'Fixture local',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

function fixtureTab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: LOCAL_TAB_ID,
    ptyId: 'pty-local',
    worktreeId: LOCAL_WORKTREE_ID,
    title: 'Fixture terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function fixtureLayout(leafId: string, ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId },
    titlesByLeafId: { [leafId]: 'Fixture pane' }
  }
}

function fixtureSession(args: {
  repoId: string
  worktreeId: string
  tab: TerminalTab
  layout: TerminalLayoutSnapshot
}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: args.repoId,
    activeWorktreeId: args.worktreeId,
    activeTabId: args.tab.id,
    tabsByWorktree: { [args.worktreeId]: [args.tab] },
    terminalLayoutsByTabId: { [args.tab.id]: args.layout },
    activeTabIdByWorktree: { [args.worktreeId]: args.tab.id },
    activeWorktreeIdsOnShutdown: [args.worktreeId],
    browserUrlHistory: [
      {
        url: 'https://fixture.test/é😀',
        normalizedUrl: 'https://fixture.test/é😀',
        title: 'Fixture',
        lastVisitedAt: 3,
        visitCount: 2
      }
    ]
  }
}

function fixtureAutomation(): Automation {
  return {
    id: 'automation-fixture',
    name: 'Fixture automation',
    prompt: 'Keep the fixture valid',
    precheck: null,
    agentId: 'claude',
    projectId: 'project-fixture',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: LOCAL_WORKTREE_ID,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 10,
    enabled: true,
    nextRunAt: 20,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 5,
    createdAt: 1,
    updatedAt: 2
  }
}

function fixtureAutomationRun(): AutomationRun {
  return {
    id: 'automation-run-fixture',
    automationId: 'automation-fixture',
    title: 'Fixture run',
    scheduledFor: 20,
    status: 'completed',
    trigger: 'manual',
    workspaceId: LOCAL_WORKTREE_ID,
    workspaceDisplayName: 'Fixture local',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'terminal-fixture',
    terminalPaneKey: 'pane-fixture',
    terminalPtyId: 'pty-local',
    outputSnapshot: {
      format: 'plain_text',
      content: 'fixture output',
      capturedAt: 21,
      truncated: false
    },
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 20,
    dispatchedAt: 20,
    createdAt: 20,
    runNumber: 1
  }
}

function fixtureWorktreeMeta(): WorktreeMeta {
  const now = Date.now()
  return {
    instanceId: 'instance-local',
    projectId: 'project-fixture',
    hostId: 'local',
    projectHostSetupId: 'setup-local',
    displayName: 'Fixture local',
    comment: 'Preserve this comment',
    linkedIssue: null,
    linkedPR: 42,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: true,
    isPinned: true,
    sortOrder: 1,
    lastActivityAt: now,
    createdAt: now
  }
}

export function buildProfileStateCutoverFixture(
  homedir = '/fixture/home'
): ProfileStateCutoverFixture {
  const localTab = fixtureTab({})
  const remoteTab = fixtureTab({
    id: REMOTE_TAB_ID,
    ptyId: 'pty-remote',
    worktreeId: REMOTE_WORKTREE_ID
  })
  const localSession = fixtureSession({
    repoId: 'repo-local',
    worktreeId: LOCAL_WORKTREE_ID,
    tab: localTab,
    layout: fixtureLayout(LOCAL_LEAF_ID, 'pty-local')
  })
  const remoteSession = fixtureSession({
    repoId: 'repo-remote',
    worktreeId: REMOTE_WORKTREE_ID,
    tab: remoteTab,
    layout: fixtureLayout(REMOTE_LEAF_ID, 'pty-remote')
  })
  const state = getDefaultPersistedState(homedir)
  state.repos = [
    fixtureRepo({}),
    fixtureRepo({
      id: 'repo-remote',
      path: '/fixture/remote',
      displayName: 'Fixture remote',
      connectionId: 'build-host',
      executionHostId: REMOTE_HOST_ID
    })
  ]
  state.projects = [fixtureProject({})]
  state.projectHostSetups = [
    fixtureSetup({}),
    fixtureSetup({
      id: 'setup-remote',
      hostId: REMOTE_HOST_ID,
      repoId: 'repo-remote',
      path: '/fixture/remote',
      displayName: 'Fixture remote',
      connectionId: 'build-host',
      executionHostId: REMOTE_HOST_ID
    })
  ]
  state.worktreeMeta = {
    [LOCAL_WORKTREE_ID]: fixtureWorktreeMeta(),
    [REMOTE_WORKTREE_ID]: {
      ...fixtureWorktreeMeta(),
      instanceId: 'instance-remote',
      hostId: REMOTE_HOST_ID,
      projectHostSetupId: 'setup-remote',
      displayName: 'Fixture remote'
    }
  }
  state.workspaceSession = localSession
  state.workspaceSessionsByHostId = { [REMOTE_HOST_ID]: remoteSession }
  state.sshTargets = [
    {
      id: 'build-host',
      label: 'Build host',
      host: 'build.example.test',
      port: 22,
      username: 'builder',
      source: 'manual',
      generation: 3
    }
  ]
  state.automations = [fixtureAutomation()]
  state.automationRuns = [fixtureAutomationRun()]
  state.settings = {
    ...state.settings,
    opencodeSessionCookie: Buffer.from('vitest-sealed:fixture-secret', 'utf-8').toString('base64')
  }
  state.ui = { ...state.ui, activeView: 'tasks', browserKagiSessionLink: null }
  return Object.assign(state, {
    futureTopLevelExtension: { keep: 'forward-compatible', nullable: null }
  })
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortForStableJson(child)])
  )
}

/** Compares state semantics while ignoring object insertion order and preserving array order. */
export function canonicalProfileStateJson(state: unknown): string {
  return JSON.stringify(sortForStableJson(state))
}
