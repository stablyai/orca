import '../unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AI_VAULT_METHODS } from './ai-vault'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const searchMocks = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock('../../../ai-vault-search/session-search-service-registry', () => ({
  searchSessionService: searchMocks.search,
  sessionSearchServiceStatus: vi.fn()
}))

afterEach(() => setStructuredAgentSessionHost(null))
it('projects the serving record before returning paired-host row identity', async () => {
  const record = { ...agentSessionRecordFixture(), conversationName: 'Saved by serving host' }
  record.providerHandleChain = [
    { ...record.providerHandleChain[0]!, handle: claudeProviderHandle('provider-session', null) }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership projection only reads this record-list member.
  setStructuredAgentSessionHost({ deps: { store: { listRecords: () => [record] } } } as never)
  const row: AiVaultSession = {
    id: 'local:claude:provider-session',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'provider-session',
    title: 'Claude Chat',
    cwd: '/folder',
    branch: null,
    model: null,
    filePath: '/session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-06T00:00:00Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this exact RPC method only reaches these runtime members.
  const runtime = {
    getRuntimeId: () => 'host-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => {}),
    listAiVaultSessions: vi.fn(async () => ({
      sessions: [row],
      issues: [],
      scannedAt: row.modifiedAt
    }))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
  const request = {
    id: 'request',
    authToken: 'token',
    method: 'aiVault.listSessions',
    params: { executionHostId: 'runtime:paired-host' }
  }
  const supported = await dispatcher.dispatch(request, {
    clientKind: 'runtime',
    clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
  })
  expect(supported).toMatchObject({
    ok: true,
    result: {
      sessions: [
        {
          executionHostId: 'runtime:paired-host',
          title: 'Saved by serving host',
          structuredSession: {
            sessionId: record.sessionId,
            workspaceId: record.location.workspaceId
          }
        }
      ]
    }
  })
  expect(
    await dispatcher.dispatch(request, { clientKind: 'runtime', clientCapabilities: [] })
  ).toMatchObject({ ok: true, result: { sessions: [] } })
})

it('owns indexed search hits only for a client that can open the native chat', async () => {
  const record = { ...agentSessionRecordFixture(), conversationName: 'Saved by serving host' }
  record.providerHandleChain = [
    { ...record.providerHandleChain[0]!, handle: claudeProviderHandle('provider-session', null) }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership projection only reads this record-list member.
  setStructuredAgentSessionHost({ deps: { store: { listRecords: () => [record] } } } as never)
  const hit = {
    agent: 'claude' as const,
    sessionId: 'provider-session',
    title: 'First prompt',
    cwd: '/folder',
    branch: null,
    updatedAt: null,
    messageCount: 1,
    score: 1,
    source: { presence: 'present' as const },
    evidence: null
  }
  searchMocks.search.mockResolvedValue({
    kind: 'results',
    hits: [hit],
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  })
  const ensureHost = vi.fn(async () => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this exact RPC method only reaches this runtime member.
  const runtime = {
    getRuntimeId: () => 'host-runtime',
    ensureStructuredAgentSessionHost: ensureHost
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
  const request = {
    id: 'request',
    authToken: 'token',
    method: 'aiVault.searchSessions',
    params: { query: 'prompt' }
  }
  expect(
    await dispatcher.dispatch(request, {
      clientKind: 'runtime',
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    })
  ).toMatchObject({
    ok: true,
    result: {
      hits: [
        {
          title: 'Saved by serving host',
          structuredSession: {
            sessionId: record.sessionId,
            workspaceId: record.location.workspaceId
          }
        }
      ]
    }
  })
  const legacy = await dispatcher.dispatch(request, {
    clientKind: 'runtime',
    clientCapabilities: []
  })
  expect(legacy).toMatchObject({ ok: true, result: { hits: [{ title: 'First prompt' }] } })
  expect(JSON.stringify(legacy)).not.toContain('structuredSession')
  // A client that gets no owners never waits on the chat host.
  expect(ensureHost).toHaveBeenCalledTimes(1)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  ensureHost.mockRejectedValueOnce(new Error('chat journal unavailable'))
  const failedInstall = await dispatcher.dispatch(request, {
    clientKind: 'runtime',
    clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
  })
  expect(failedInstall).toMatchObject({ ok: true, result: { hits: [{ title: 'First prompt' }] } })
  expect(JSON.stringify(failedInstall)).not.toContain('structuredSession')
  expect(warn).toHaveBeenCalled()
  warn.mockRestore()
})
