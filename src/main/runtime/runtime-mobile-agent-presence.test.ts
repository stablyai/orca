import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'
import { AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'

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
    tabFor: (capabilities: string[]) =>
      projectSessionTabsForClient(
        projectRuntimeMobileSessionTabs(snapshot, host),
        'mobile',
        capabilities
      ).tabs[0]
  }
}

describe('headless mobile owner projection', () => {
  it('preserves an idle host owner without a renderer or an agent title', () => {
    const { setRows, tabFor } = projection()
    setRows([ownerRow(false)])
    expect(tabFor(capable)).toMatchObject({
      agentStatus: { agentPresence: { agent: 'claude', process: processIdentity } }
    })
  })

  it('carries a positive exit through the snapshot even with a stale launch hint', () => {
    const { setRows, tabFor } = projection()
    setRows([
      {
        ...ownerRow(true),
        model: 'claude-opus',
        providerSession: { key: 'session_id', id: 'claude-session' }
      }
    ])
    const tab = tabFor(capable)
    expect(tab).toMatchObject({
      launchAgent: 'claude',
      agentStatus: { agentPresence: { agent: 'claude', process: processIdentity, ended: true } }
    })
    // An exited owner is identity only; its session, model and type must not reach a successor.
    const status = tab?.type === 'terminal' ? tab.agentStatus : undefined
    expect(status).not.toHaveProperty('providerSession')
    expect(status).not.toHaveProperty('model')
    expect(status).not.toHaveProperty('agentType')
  })

  it('negotiates the full snapshot and never accepts client-published presence as host evidence', () => {
    const row = ownerRow(true)
    const spoofedAuthority = { agentPresenceFromExecutionHost: true }
    const { setRows, tabFor } = projection({
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
      },
      ...spoofedAuthority
    })
    setRows([row])
    // The published row keeps its own fields; only the host's presence replaces the client's.
    expect(tabFor(capable)).toMatchObject({
      agentStatus: { agentPresence: row.agentPresence, updatedAt: 99999, stateStartedAt: 99999 }
    })
    expect(tabFor([])).not.toHaveProperty('agentStatus.agentPresence')
    setRows([])
    expect(tabFor(capable)).not.toHaveProperty('agentStatus.agentPresence')
  })
})
