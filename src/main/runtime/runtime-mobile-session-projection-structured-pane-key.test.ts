import { expect, it, vi } from 'vitest'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

const leaf = '11111111-1111-4111-8111-111111111111'
const sessionId = 'orca-session'
// Why: status rows name the provider's session, which is never Orca's session id — a match has to
// go through the record store first.
const providerSessionId = 'claude-provider-session'

function row(paneKey: string, providerId: string): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { key: 'session_id', id: providerId }
  }
}

function publishChatTab(rows: readonly AgentStatusIpcPayload[]): RuntimeMobileSessionAgentTab {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every host member this projection path calls.
  const host = {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => [],
    getProviderSessionSnapshot: () => [...rows],
    resolveProviderSessionId: (id: string) => (id === sessionId ? providerSessionId : undefined),
    getLeafKey: () => 'leaf',
    findPty: () => null,
    getRetainedStatus: () => null,
    getTrackedTitle: () => null,
    issuePtyHandle: vi.fn(() => 'handle'),
    recordPty: vi.fn(() => null),
    buildPtyStatus: () => ({}),
    sanitizeGroups: () => [],
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set()
  } as unknown as RuntimeMobileSessionProjectionHost
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one chat tab is the only snapshot field this projection path reads.
  const snapshot = {
    worktree: 'workspace',
    publicationEpoch: 'headless:epoch',
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${sessionId}`,
        title: 'Claude',
        sessionId,
        agent: 'claude',
        isActive: true
      }
    ]
  } as RuntimeMobileSessionTabsSnapshot
  const [tab] = projectRuntimeMobileSessionTabs(snapshot, host).tabs
  if (tab?.type !== 'agent-session') {
    throw new Error('the snapshot declares one agent-session tab')
  }
  return tab
}

it('publishes the pane the chat runs in, so a pane-keyed tap can resolve the tab', () => {
  expect(publishChatTab([row(`pty-tab:${leaf}`, providerSessionId)])).toHaveProperty(
    'paneKey',
    `pty-tab:${leaf}`
  )
})

it('publishes no pane key when no status row names the session', () => {
  expect(publishChatTab([])).not.toHaveProperty('paneKey')
})

it('publishes no pane key when the pane belongs to another session', () => {
  expect(publishChatTab([row(`pty-tab:${leaf}`, 'another')])).not.toHaveProperty('paneKey')
})

it('matches on the provider session, not on Orca session id', () => {
  expect(publishChatTab([row(`pty-tab:${leaf}`, sessionId)])).not.toHaveProperty('paneKey')
})
