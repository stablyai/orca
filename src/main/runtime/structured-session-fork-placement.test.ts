import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
await import('./orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('./orca-runtime')
void (await import('./orca-runtime-test-mocks/setup.spec'))
await import('./orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { makeRuntimeStoreWithWorkspaceSession, TEST_WORKTREE_ID: WT } =
  await import('./orca-runtime-tests/orca-runtime-test-fixtures.spec')

type Anchor = 'ordinary' | 'missing' | 'reopened' | 'stale-reopened' | 'old-alias'
const REOPENED = 'agent-chat-tab-v1-current-source'
const rawId = (sessionId: string) => `agent-session:${sessionId}`
const savedId = (sessionId: string) => `structured-agent-session-${sessionId}`
const sourceId = (anchor: Anchor, saved = false) =>
  ['reopened', 'stale-reopened', 'old-alias'].includes(anchor)
    ? REOPENED
    : saved
      ? savedId('source')
      : rawId('source')

function savedSession(anchor: Anchor, listed: boolean): WorkspaceSessionState {
  const tab = (sessionId: string, groupId: string): Tab => ({
    id: sessionId === 'source' ? sourceId(anchor, true) : savedId(sessionId),
    entityId: sessionId,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    executionHostId: 'local',
    worktreeId: WT,
    groupId,
    label: sessionId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  return {
    activeRepoId: null,
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: {
      [WT]: [
        tab('source', 'G1'),
        tab('B', 'G1'),
        tab('active', 'G2'),
        ...(listed ? [tab('child', 'G2')] : [])
      ]
    },
    tabGroups: {
      [WT]: [
        {
          id: 'G1',
          worktreeId: WT,
          activeTabId: sourceId(anchor, true),
          tabOrder: [sourceId(anchor, true), savedId('B')]
        },
        {
          id: 'G2',
          worktreeId: WT,
          activeTabId: savedId('active'),
          tabOrder: [savedId('active'), ...(listed ? [savedId('child')] : [])]
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'G2' },
    tabGroupLayouts: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'G1' },
        second: { type: 'leaf', groupId: 'G2' }
      }
    }
  }
}

function rawSnapshot(anchor: Anchor, listed: boolean): RuntimeMobileSessionTabsSnapshot {
  const chat = (sessionId: string) => ({
    type: 'agent-session' as const,
    id: sessionId === 'source' ? sourceId(anchor) : rawId(sessionId),
    title: sessionId,
    sessionId,
    agent: 'claude' as const,
    isActive: sessionId === 'active'
  })
  return {
    worktree: WT,
    publicationEpoch: 'window:fork-source',
    snapshotVersion: 1,
    activeGroupId: 'G2',
    activeTabId: rawId('active'),
    activeTabType: 'agent-session',
    tabGroups: [
      { id: 'G1', activeTabId: sourceId(anchor), tabOrder: [sourceId(anchor), rawId('B')] },
      {
        id: 'G2',
        activeTabId: rawId('active'),
        tabOrder: [rawId('active'), ...(listed ? [rawId('child')] : [])]
      }
    ],
    tabs: [chat('source'), chat('B'), chat('active'), ...(listed ? [chat('child')] : [])]
  }
}

it('keeps an explicit saved null selection when its first chat restores', () => {
  const saved = savedSession('ordinary', false)
  saved.activeGroupIdByWorktree![WT] = 'G1'
  saved.tabGroups![WT]![0]!.activeTabId = null
  const fixture = makeRuntimeStoreWithWorkspaceSession(saved)
  const runtime = new OrcaRuntimeService(fixture.runtimeStore)
  runtime.projectStructuredAgentSessionTab({
    workspaceId: WT,
    sessionId: 'source',
    agent: 'claude',
    activate: false
  })
  const snapshot = runtime.mobileSessionTabsByWorktree.get(WT)!
  expect(snapshot.activeGroupId).toBe('G1')
  expect(snapshot.tabGroups?.[0]?.activeTabId).toBeNull()
  expect(snapshot.activeTabId).toBeNull()
  expect(snapshot.tabs.filter((tab) => tab.isActive)).toEqual([])
})

it('keeps current pending navigation when saved order materializes another chat', () => {
  const fixture = makeRuntimeStoreWithWorkspaceSession(savedSession('ordinary', false))
  const runtime = new OrcaRuntimeService(fixture.runtimeStore)
  const current = rawSnapshot('ordinary', false)
  current.tabGroups![1]!.activeTabId = 'agent-session:pending'
  current.tabGroups![1]!.tabOrder.push('agent-session:pending')
  current.activeTabId = null
  current.activeTabType = null
  current.tabs = current.tabs
    .filter((tab) => tab.id !== 'agent-session:source')
    .map((tab) => ({ ...tab, isActive: false }))
  runtime.storeMobileSessionSnapshot(WT, current)
  runtime.projectStructuredAgentSessionTab({
    workspaceId: WT,
    sessionId: 'source',
    agent: 'claude',
    activate: false
  })
  const snapshot = runtime.mobileSessionTabsByWorktree.get(WT)!
  expect(snapshot.activeGroupId).toBe('G2')
  expect(snapshot.tabGroups?.find((group) => group.id === 'G2')?.activeTabId).toBe(
    'agent-session:pending'
  )
  expect(snapshot.activeTabId).toBeNull()
  expect(snapshot.tabs.filter((tab) => tab.isActive)).toEqual([])
})
