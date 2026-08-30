import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  agentSessionProviderHandleKey,
  appendAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import { agentSessionLeaseFixture } from '../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

function codexLink(threadId: string, linkId: string): AgentSessionProviderHandleLink {
  return {
    linkId,
    origin: 'created',
    mintedAtFence: 7,
    observedAt: 1_000,
    handle: { provider: 'codex', threadId }
  }
}

function codexRecord(chain: AgentSessionProviderHandleLink[]): AgentSessionRecord {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: 'session-1',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    providerHandleChain: chain,
    accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' },
    lease: agentSessionLeaseFixture({ sessionId: 'session-1' }),
    createdAt: 1,
    updatedAt: 2
  }
}

function installHost(recordsBySessionId: Record<string, AgentSessionRecord | null>): void {
  setStructuredAgentSessionHost({
    deps: { store: { getRecord: (id: string) => recordsBySessionId[id] ?? null } }
  } as never)
}

async function publishedAgentTab(
  runtime: OrcaRuntimeService
): Promise<{ providerSessionId?: string } | undefined> {
  const snapshot = await runtime.listMobileSessionTabs('id:workspace-1')
  return snapshot.tabs.find((tab) => tab.type === 'agent-session') as
    | { providerSessionId?: string }
    | undefined
}

describe('structured chat tab provider session identity', () => {
  it('publishes the Codex thread the session is bound to', async () => {
    installHost({ 'session-1': codexRecord([codexLink('thread-1', 'link-1')]) })
    const runtime = new OrcaRuntimeService()

    runtime.publishStructuredAgentSessionTab({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agent: 'codex',
      activate: true
    })

    expect((await publishedAgentTab(runtime))?.providerSessionId).toBe('thread-1')
  })

  it('publishes no identity while the provider has not proven one', async () => {
    installHost({ 'session-1': codexRecord([]) })
    const runtime = new OrcaRuntimeService()

    runtime.publishStructuredAgentSessionTab({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agent: 'codex',
      activate: true
    })

    const tab = await publishedAgentTab(runtime)
    expect(tab).toBeDefined()
    expect(tab).not.toHaveProperty('providerSessionId')
  })

  it('carries a thread proven after the tab was already published', async () => {
    const records: Record<string, AgentSessionRecord> = { 'session-1': codexRecord([]) }
    installHost(records)
    const runtime = new OrcaRuntimeService()
    runtime.publishStructuredAgentSessionTab({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agent: 'codex',
      activate: true
    })

    records['session-1'] = codexRecord([codexLink('thread-1', 'link-1')])
    runtime.touchMobileSessionTabsForWorktree('workspace-1', {
      immediate: true,
      refreshStructuredProviderSessions: true
    })

    expect((await publishedAgentTab(runtime))?.providerSessionId).toBe('thread-1')
  })

  it('names the conversation the session writes to now, not the one it forked from', async () => {
    const chain = appendAgentSessionProviderHandleLink([codexLink('thread-old', 'link-1')], {
      ...codexLink('thread-new', 'link-2'),
      origin: 'forked',
      forkedFromKey: agentSessionProviderHandleKey({ provider: 'codex', threadId: 'thread-old' })
    })
    installHost({ 'session-1': codexRecord(chain) })
    const runtime = new OrcaRuntimeService()
    runtime.publishStructuredAgentSessionTab({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agent: 'codex',
      activate: true
    })

    expect((await publishedAgentTab(runtime))?.providerSessionId).toBe('thread-new')
  })
})
