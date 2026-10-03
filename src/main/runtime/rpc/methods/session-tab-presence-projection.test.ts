import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../../shared/runtime-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { HOST_AGENT_PRESENCE } from '../../runtime-mobile-agent-presence-projection'
import { projectSessionTabPresenceForClient } from './session-tab-presence-projection'

const owner = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' },
  ended: true
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
    ...(covered ? { [HOST_AGENT_PRESENCE]: owner } : {})
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
  it('publishes an owner beside the turn, with or without one, to a capable connection', () => {
    const capable = [AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY]
    expect(projectSessionTabPresenceForClient(snapshot(true), capable).tabs[0]).toEqual({
      ...snapshot(false).tabs[0],
      agentPresence: owner
    })
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
  it('serves a client that only knows the in-turn v1 shape no presence at all', () => {
    expect(AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY).toBe('agent-process-presence.v2')
    const tabs = projectSessionTabPresenceForClient(snapshot(true), [
      'agent-process-presence.v1'
    ]).tabs
    expect(tabs).toEqual(snapshot(false).tabs)
    expect(JSON.stringify(tabs)).not.toContain('agentPresence')
  })

  it('asks a v1 host for nothing, since its in-turn shape is one this client does not read', () => {
    // A v1 host projects the owner into `agentStatus` only for clients that list v1.
    expect(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain('agent-process-presence.v2')
    expect(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES).not.toContain('agent-process-presence.v1')
  })

  it('leaves the published turn untouched', () => {
    const capable = [AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY]
    expect(projectSessionTabPresenceForClient(snapshot(true, published), capable).tabs[0]).toEqual({
      ...snapshot(false, published).tabs[0],
      agentPresence: owner
    })
    expect(projectSessionTabPresenceForClient(snapshot(true, published), []).tabs).toEqual(
      snapshot(false, published).tabs
    )
  })
})
