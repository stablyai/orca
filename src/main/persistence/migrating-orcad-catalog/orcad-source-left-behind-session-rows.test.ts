import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { withoutLeftBehindSessionRows } from './orcad-source-left-behind-session-rows'
import type { OrcadMigrationSourceScope } from './orcad-source-scope'

const WORKTREE = 'repo-0::/home/dev/src/project-0'
const SCOPE: OrcadMigrationSourceScope = {
  targetId: 'ssh-box',
  targetGeneration: 1,
  hostId: toSshExecutionHostId('ssh-box'),
  repoIds: new Set(['repo-0']),
  folderWorkspaceKeys: new Set(),
  sharedRepoIds: new Set(),
  partitionHostId: toSshExecutionHostId('ssh-box')
}

function resume(paneKey: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId,
    worktreeId: WORKTREE,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${tabId}` },
    prompt: 'Saved prompt',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe('withoutLeftBehindSessionRows', () => {
  it('drops pane-keyed records of a skipped foreign tab, legacy keys included', () => {
    const session = getDefaultWorkspaceSession()
    session.unifiedTabs = {
      [WORKTREE]: ['own', 'foreign'].map((id, sortOrder) => ({
        id,
        entityId: id,
        groupId: 'group',
        worktreeId: WORKTREE,
        contentType: 'terminal' as const,
        label: id,
        customLabel: null,
        color: null,
        sortOrder,
        createdAt: 1,
        ...(id === 'foreign' ? { executionHostId: 'runtime:env-other' } : {})
      }))
    }
    session.tabGroups = {
      [WORKTREE]: [
        { id: 'group', worktreeId: WORKTREE, activeTabId: 'own', tabOrder: ['own', 'foreign'] }
      ]
    }
    session.sleepingAgentSessionsByPaneKey = {
      'own:0': resume('own:0', 'own'),
      'foreign:0': resume('foreign:0', 'foreign')
    }
    session.terminalPtyIncarnationsByPaneKey = { 'own:0': 'inc-own', 'foreign:0': 'inc-foreign' }
    const exported = withoutLeftBehindSessionRows(session, SCOPE, true)
    expect(Object.keys(exported.sleepingAgentSessionsByPaneKey ?? {})).toEqual(['own:0'])
    expect(Object.keys(exported.terminalPtyIncarnationsByPaneKey ?? {})).toEqual(['own:0'])
    expect(exported.tabGroups?.[WORKTREE]?.[0]?.tabOrder).toEqual(['own'])
  })
})
