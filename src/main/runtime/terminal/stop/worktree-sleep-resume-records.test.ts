import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { dropStrandedSleepRecord } from './worktree-sleep-resume-records'

const slept: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'sess-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'worktree-sleep',
  restoreOnTabOpenOnly: true
}

function session(
  tabIds: string[],
  record: SleepingAgentSessionRecord = slept
): WorkspaceSessionState {
  const tab = (id: string) => ({
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: { 'wt-1': tabIds.map(tab) },
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  }
}

describe('dropStrandedSleepRecord', () => {
  it("drops a workspace sleep's record once no tab holds its pane", () => {
    expect(
      dropStrandedSleepRecord(session([]), slept.paneKey)?.sleepingAgentSessionsByPaneKey
    ).toEqual({})
  })

  // A window must not discard a record main still resumes when its tab opens.
  it('keeps a record whose tab is still listed, and window-owned records', () => {
    expect(dropStrandedSleepRecord(session(['tab-1']), slept.paneKey)).toBeNull()
    const quit = { ...slept, origin: 'quit' as const }
    expect(dropStrandedSleepRecord(session([], quit), quit.paneKey)).toBeNull()
  })
})
