import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../../shared/runtime-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { HOST_AGENT_PRESENCE_STATUS } from '../../runtime-mobile-agent-presence-projection'
import { projectSessionTabPresenceForClient } from './session-tab-presence-projection'

const status = {
  state: 'done',
  prompt: '',
  paneKey: 'tab:leaf',
  updatedAt: 10,
  stateStartedAt: 10,
  stateHistory: [],
  agentPresence: {
    agent: 'claude',
    process: { pid: 42, platform: 'linux', startTime: 'boot:42' },
    ended: true
  }
} as const
const published: AgentStatusEntry = {
  state: 'working',
  prompt: 'second task',
  paneKey: 'tab:leaf',
  updatedAt: 30,
  stateStartedAt: 20,
  turnStartedAt: 20,
  agentType: 'claude',
  lastCompletedAssistantMessage: 'first answer',
  orchestration: { taskId: 'task-1', dispatchId: 'dispatch-1', taskTitle: 'Refactor' },
  stateHistory: [{ state: 'done', prompt: 'first task', startedAt: 10 }]
}
function snapshot(
  covered: boolean,
  agentStatus?: AgentStatusEntry
): RuntimeMobileSessionTabsResult {
  const tab = {
    type: 'terminal',
    id: 'tab::leaf',
    parentTabId: 'tab',
    leafId: 'leaf',
    title: 'zsh',
    isActive: true,
    status: 'pending-handle',
    terminal: null,
    ...(agentStatus ? { agentStatus } : {}),
    ...(covered ? { [HOST_AGENT_PRESENCE_STATUS]: status } : {})
  } as const
  return {
    publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
    snapshotVersion: 1,
    activeGroupId: null,
    worktree: 'folder',
    activeTabId: tab.id,
    activeTabType: 'terminal',
    tabs: [tab]
  }
}
describe('connection scoped presence projection', () => {
  it('keeps old clients on the exact legacy row', () => {
    expect(projectSessionTabPresenceForClient(snapshot(true), []).tabs).toEqual(
      snapshot(false).tabs
    )
    expect(JSON.stringify(snapshot(true))).not.toContain('agentPresence')
  })
  it('publishes an ended owner to a capable connection', () => {
    expect(
      projectSessionTabPresenceForClient(snapshot(true), [
        AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY
      ]).tabs[0]
    ).toMatchObject({ agentStatus: status })
  })
  it('does not cover an unidentified row or retain another connection’s capability', () => {
    const capable = [AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY]
    expect(projectSessionTabPresenceForClient(snapshot(false), capable).tabs).toEqual(
      snapshot(false).tabs
    )
    projectSessionTabPresenceForClient(snapshot(true), capable)
    expect(projectSessionTabPresenceForClient(snapshot(true), undefined).tabs).toEqual(
      snapshot(false).tabs
    )
  })
  it('adds host presence to the published status instead of replacing it', () => {
    const capable = [AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY]
    expect(projectSessionTabPresenceForClient(snapshot(true, published), capable).tabs[0]).toEqual({
      ...snapshot(false, published).tabs[0],
      agentStatus: { ...published, agentPresence: status.agentPresence }
    })
    expect(projectSessionTabPresenceForClient(snapshot(true, published), []).tabs).toEqual(
      snapshot(false, published).tabs
    )
  })
})
