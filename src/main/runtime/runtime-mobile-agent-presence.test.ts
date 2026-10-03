import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'
import { AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentPaneOwner } from '../../shared/agent-process-presence'

const processIdentity = { pid: 4001, platform: 'linux', startTime: 'boot:123' } as const
const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey('tab', leafId)
const capable = [AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY]

function ownerRow(ended: boolean) {
  const row: AgentStatusIpcPayload = {
    paneKey,
    tabId: 'tab',
    worktreeId: 'folder',
    connectionId: null,
    state: 'done',
    prompt: '',
    receivedAt: 10,
    stateStartedAt: 5,
    agentType: 'claude',
    agentPresence: {
      agent: 'claude',
      process: processIdentity,
      ...(ended ? { ended: true } : {})
    },
    ...(ended ? { providerSessionOnly: true } : {})
  }
  return row
}

function projection(agentStatus?: AgentStatusEntry) {
  let rows: AgentStatusIpcPayload[] = []
  let owner: AgentPaneOwner | undefined
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'folder',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        parentTabId: 'tab',
        leafId,
        title: 'zsh',
        isActive: true,
        launchAgent: 'claude',
        ...(agentStatus ? { agentStatus } : {})
      }
    ]
  }
  const host: RuntimeMobileSessionProjectionHost = {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => rows,
    getAgentOwner: () => owner,
    getProviderSessionSnapshot: () => rows,
    getStatusSnapshot: () => [],
    getLeafKey: () => '',
    findPty: () => null,
    getRetainedStatus: () => null,
    getTrackedTitle: () => null,
    getTitleDisplayClear: () => null,
    issuePtyHandle: () => 'terminal',
    recordPty: () => {
      throw new Error('unexpected pty')
    },
    buildPtyStatus: () => ({}),
    sanitizeGroups: () => undefined,
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set()
  }
  return {
    setRows: (next: AgentStatusIpcPayload[]) => {
      rows = next
    },
    setOwner: (next: AgentPaneOwner | undefined) => {
      owner = next
    },
    tabFor: (capabilities: string[]) =>
      projectSessionTabsForClient(
        projectRuntimeMobileSessionTabs(snapshot, host),
        'mobile',
        capabilities
      ).tabs[0]
  }
}

function hostOwner(ended: boolean): AgentPaneOwner {
  return {
    paneKey,
    connectionId: null,
    worktreeId: 'folder',
    tabId: 'tab',
    presence: { agent: 'claude', process: processIdentity, ...(ended ? { ended: true } : {}) },
    receivedAt: 10
  }
}

describe('headless mobile owner projection', () => {
  it('publishes an idle host owner beside its turn without a renderer or an agent title', () => {
    const { setRows, setOwner, tabFor } = projection()
    setRows([ownerRow(false)])
    setOwner(hostOwner(false))
    const tab = tabFor(capable)
    expect(tab).toMatchObject({ agentPresence: { agent: 'claude', process: processIdentity } })
    expect(tab).not.toHaveProperty('agentStatus.agentPresence')
  })

  it('publishes a hookless live owner as identity without inventing a done turn', () => {
    const { setOwner, tabFor } = projection()
    setOwner(hostOwner(false))
    expect(tabFor(capable)).toMatchObject({
      agentPresence: { agent: 'claude', process: processIdentity }
    })
    expect(tabFor(capable)).not.toHaveProperty('agentStatus')
    expect(tabFor([])).not.toHaveProperty('agentPresence')
  })

  it('carries a positive exit beside the stale launch hint', () => {
    const { setOwner, tabFor } = projection()
    setOwner(hostOwner(true))
    expect(tabFor(capable)).toMatchObject({
      launchAgent: 'claude',
      agentPresence: { agent: 'claude', process: processIdentity, ended: true }
    })
    expect(tabFor(capable)).not.toHaveProperty('agentStatus')
  })

  it('never accepts client-published presence as host evidence', () => {
    const { setOwner, tabFor } = projection({
      state: 'done',
      prompt: '',
      paneKey,
      updatedAt: 99999,
      stateStartedAt: 99999,
      stateHistory: [],
      agentType: 'claude',
      agentPresence: {
        agent: 'claude',
        process: processIdentity,
        observation: { epoch: 'client', sequence: 999 }
      }
    })
    setOwner(hostOwner(true))
    expect(tabFor(capable)).toMatchObject({
      agentPresence: hostOwner(true).presence,
      agentStatus: { updatedAt: 99999, stateStartedAt: 99999 }
    })
    expect(tabFor(capable)).not.toHaveProperty('agentStatus.agentPresence')
    expect(tabFor([])).not.toHaveProperty('agentPresence')
    setOwner(undefined)
    expect(tabFor(capable)).not.toHaveProperty('agentPresence')
  })
})
