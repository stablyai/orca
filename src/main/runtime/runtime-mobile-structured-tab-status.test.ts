import { describe, expect, it, vi } from 'vitest'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { AgentHookServer } from '../agent-hooks/server'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const WORKTREE_ID = 'repo-1::/workspace/app'
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function projectChatTab(store: AgentHookServer, worktree: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a chat tab reads only the live browser tabs and the pane's status rows; the rest finalizes the result.
  const host = {
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: (paneKey: string) => store.getStatusSnapshotForPane(paneKey),
    sanitizeGroups: () => [],
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set()
  } as unknown as RuntimeMobileSessionProjectionHost
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one chat tab is the only snapshot field this projection path reads.
  const snapshot = {
    worktree,
    publicationEpoch: 'epoch',
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${SESSION}`,
        title: 'Claude',
        sessionId: SESSION,
        agent: 'claude',
        isActive: true
      }
    ]
  } as RuntimeMobileSessionTabsSnapshot
  return projectRuntimeMobileSessionTabs(snapshot, host).tabs[0]
}

describe('a chat tab on the phone', () => {
  it("carries the host's structured row for its session, and only in that workspace", () => {
    const store = new AgentHookServer()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields a structured status summary needs for ingest.
    const summary = {
      sessionId: SESSION,
      workspaceId: WORKTREE_ID,
      agent: 'claude',
      status: 'working',
      latestPrompt: 'ship the thing',
      updatedAt: 1_757_030_400_000,
      hostExecutionOwned: true
    } as AgentSessionStatusSummary
    store.ingestStructuredStatus(
      summary,
      makeStructuredAgentStatusSubject(
        {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: WORKTREE_ID,
          workspaceKind: 'git-worktree'
        },
        SESSION
      )
    )

    expect(projectChatTab(store, WORKTREE_ID)).toMatchObject({
      type: 'agent-session',
      chatStatus: { state: 'working', structuredHostOwned: true }
    })
    expect(projectChatTab(store, 'repo-1::/workspace/other')).not.toHaveProperty('chatStatus')
  })
})
