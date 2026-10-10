import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  collectPersistedSessionWorktreeOwners,
  collectWorkspaceSessionWorktreeOwners
} from './session-worktree-ownership'

const TARGET = 'repo-1::/workspace/target'
const OTHER = 'repo-1::/workspace/other'

function sessionWith(field: keyof WorkspaceSessionState, value: unknown): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), [field]: value } as WorkspaceSessionState
}

function collected(session: WorkspaceSessionState): string[] {
  return [...collectWorkspaceSessionWorktreeOwners(session, new Set([TARGET]))]
}

const OWNER_KEYED_FIELD_VALUES = [
  ['tabsByWorktree', []],
  ['openFilesByWorktree', []],
  ['activeFileIdByWorktree', null],
  ['browserTabsByWorktree', []],
  ['activeBrowserTabIdByWorktree', null],
  ['clientHostedBrowserPagesByWorktree', []],
  ['activeTabTypeByWorktree', 'terminal'],
  ['activeTabIdByWorktree', null],
  ['unifiedTabs', []],
  ['tabGroups', []],
  ['tabGroupLayouts', { type: 'leaf', groupId: 'group-1' }],
  ['activeGroupIdByWorktree', 'group-1'],
  ['lastVisitedAtByWorktreeId', 0],
  ['defaultTerminalTabsAppliedByWorktreeId', true]
] as const satisfies readonly [keyof WorkspaceSessionState, unknown][]

describe('workspace session worktree ownership', () => {
  it.each(OWNER_KEYED_FIELD_VALUES)(
    'treats a key in %s as ownership even when its bucket is empty or null',
    (field, value) => {
      expect(collected(sessionWith(field, { [TARGET]: value }))).toEqual([TARGET])
    }
  )

  it.each([
    ['active worktree', sessionWith('activeWorktreeId', TARGET)],
    ['active workspace', sessionWith('activeWorkspaceKey', worktreeWorkspaceKey(TARGET))],
    ['shutdown owner', sessionWith('activeWorktreeIdsOnShutdown', [TARGET])],
    [
      'host-qualified recency owner',
      sessionWith('lastVisitedAtByWorktreeId', { [`ssh:builder|${TARGET}`]: 1 })
    ]
  ])('collects the %s', (_label, session) => {
    expect(collected(session)).toEqual([TARGET])
  })

  it.each([
    ['terminal tab', 'tabsByWorktree', { [OTHER]: [{ worktreeId: TARGET }] }],
    ['open file', 'openFilesByWorktree', { [OTHER]: [{ worktreeId: TARGET }] }],
    ['unified tab', 'unifiedTabs', { [OTHER]: [{ worktreeId: TARGET }] }],
    ['tab group', 'tabGroups', { [OTHER]: [{ worktreeId: TARGET }] }],
    ['browser workspace', 'browserTabsByWorktree', { [OTHER]: [{ worktreeId: TARGET }] }],
    [
      'browser workspace document',
      'browserTabsByWorktree',
      { [OTHER]: [{ worktreeId: OTHER, docLocation: { worktreeId: TARGET } }] }
    ],
    ['browser page', 'browserPagesByWorkspace', { page: [{ worktreeId: TARGET }] }],
    [
      'browser page document',
      'browserPagesByWorkspace',
      { page: [{ worktreeId: OTHER, docLocation: { worktreeId: TARGET } }] }
    ],
    [
      'browser close intent',
      'clientHostedBrowserCloseIntentsByEnvironment',
      { environment: [{ worktreeId: TARGET }] }
    ],
    ['sleeping agent', 'sleepingAgentSessionsByPaneKey', { pane: { worktreeId: TARGET } }],
    ['terminal tombstone', 'terminalSurfaceTombstonesByPaneKey', { pane: { worktreeId: TARGET } }],
    [
      'closed-terminal tombstone',
      'closedTerminalTabTombstonesByTabId',
      { tab: { worktreeId: TARGET } }
    ]
  ] as const)(
    'collects a %s value even when its enclosing key names something else',
    (_label, field, value) => {
      expect(collected(sessionWith(field, value))).toEqual([TARGET])
    }
  )

  it('collects ownership from every persisted host partition', () => {
    const state = getDefaultPersistedState('/home/test')
    state.workspaceSessionsByHostId = {
      'ssh:builder': sessionWith('tabsByWorktree', { [TARGET]: [] }),
      'runtime:environment': sessionWith('activeWorktreeIdsOnShutdown', [OTHER])
    }

    expect(
      [...collectPersistedSessionWorktreeOwners(state, new Set([TARGET, OTHER]))].sort()
    ).toEqual([OTHER, TARGET])
  })

  it('prefers an exact candidate id over workspace-key prefix parsing', () => {
    const prefixedId = 'folder::/workspace/target'
    const session = sessionWith('tabsByWorktree', { [prefixedId]: [] })

    expect([...collectWorkspaceSessionWorktreeOwners(session, new Set([prefixedId]))]).toEqual([
      prefixedId
    ])
  })

  it('matches canonically equivalent Unicode worktree owners', () => {
    const candidateId = 'repo-1::/workspace/Café'.normalize('NFC')
    const ownerId = candidateId.normalize('NFD')
    const session = sessionWith('activeWorktreeId', ownerId)

    expect([...collectWorkspaceSessionWorktreeOwners(session, new Set([candidateId]))]).toEqual([
      candidateId
    ])
  })

  it('matches Windows worktree owners across drive case and slash spelling', () => {
    const candidateId = 'repo-1::D:/Agentic/game2'
    const session = sessionWith('activeWorktreeId', 'repo-1::d:\\agentic\\game2')

    expect([...collectWorkspaceSessionWorktreeOwners(session, new Set([candidateId]))]).toEqual([
      candidateId
    ])
  })

  it('matches macOS /private/tmp session owners to /tmp metadata', () => {
    const candidateId = 'repo-1::/private/tmp/orca/target'
    const session = sessionWith('activeWorktreeId', 'repo-1::/tmp/orca/target')

    expect([
      ...collectWorkspaceSessionWorktreeOwners(session, new Set([candidateId]), 'darwin')
    ]).toEqual([candidateId])
  })

  it('preserves every candidate that shares an owner comparison key', () => {
    const nfcId = 'repo-1::/workspace/Café'.normalize('NFC')
    const nfdId = nfcId.normalize('NFD')
    const session = sessionWith('activeWorktreeId', nfcId)

    expect(
      [...collectWorkspaceSessionWorktreeOwners(session, new Set([nfcId, nfdId]))].sort()
    ).toEqual([nfcId, nfdId].sort())
  })

  it('ignores fields whose keys cannot identify a worktree owner', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TARGET,
      activeTabId: TARGET,
      terminalLayoutsByTabId: { [TARGET]: { root: null } },
      remoteSessionIdsByTabId: { [TARGET]: TARGET },
      terminalPtyIncarnationsByPaneKey: { [TARGET]: TARGET },
      terminalTopologyRevisionByRepoId: { [TARGET]: 1 }
    } as unknown as WorkspaceSessionState

    expect(collected(session)).toEqual([])
  })
})
