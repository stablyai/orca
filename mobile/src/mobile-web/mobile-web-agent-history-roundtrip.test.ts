import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'

it('round trips opaque agent history and resume through the production bridge', async () => {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'status.get') {
      return {
        ok: true,
        result: { capabilities: ['aiVault.v1'], hostPlatform: 'darwin' }
      }
    }
    if (method === 'worktree.ps') {
      return { ok: true, result: { worktrees: [worktree()] } }
    }
    if (method === 'repo.list') {
      return { ok: true, result: { repos: [] } }
    }
    if (
      method === 'folderWorkspace.list' ||
      method === 'projectGroup.list' ||
      method === 'settings.get'
    ) {
      return { ok: true, result: {} }
    }
    if (method === 'aiVault.listSessions') {
      return {
        ok: true,
        result: { sessions: [hostSession()], issues: [] }
      }
    }
    throw new Error(`unexpected method ${method}`)
  })
  const rpcClient = { sendRequest } as unknown as RpcClient
  const requestIds = ['A', 'B', 'C']
  let requestIndex = 0
  const { broker, client } = createMobileWebBridgeRoundtripFixture({
    grants: [
      agentHistoryGrant('snapshot'),
      agentHistoryGrant('preview'),
      agentHistoryGrant('resume')
    ],
    rpcClient,
    createRequestId: () => requestIds[requestIndex++]!.repeat(22),
    navigationAuthority: {
      route: vi.fn(),
      reconnect: vi.fn(),
      removeHost: vi.fn()
    },
    randomBytes: (length) => new Uint8Array(length).fill(5)
  })
  const route = await broker.resolveNavigationRoute('host-workspace')
  if (route.kind !== 'session') {
    throw new Error('expected session route')
  }

  const snapshot = await client.agentHistory.snapshot({
    workspaceId: route.workspaceId,
    scope: 'workspace',
    query: '',
    force: false
  })
  expect(snapshot.sessions).toHaveLength(1)
  const row = snapshot.sessions[0]!
  expect(row).toMatchObject({
    title: 'Private session',
    agent: 'codex',
    groupLabel: 'ada/mobile-rearch'
  })
  expect(JSON.stringify(row)).not.toContain('/Users/ada')
  expect(JSON.stringify(row)).not.toContain('provider-secret')

  await expect(client.agentHistory.preview(row.handle)).resolves.toEqual({
    messages: [{ role: 'assistant', text: 'safe preview' }]
  })
  const resume = await client.agentHistory.resume({
    workspaceId: route.workspaceId,
    sessionHandle: row.handle
  })
  expect(JSON.stringify(resume)).not.toContain('/Users/ada')
  expect(JSON.stringify(resume)).not.toContain('provider-secret')
})

function agentHistoryGrant(operation: 'snapshot' | 'preview' | 'resume') {
  return {
    capability: 'agentHistory' as const,
    operation,
    limits: {
      maxRequestBytes: 2048,
      maxResponseBytes: 384 * 1024,
      maxConcurrent: 2,
      rateCapacity: 8,
      rateRefillPerSecond: 8
    }
  }
}

function hostSession() {
  return {
    id: 'native-session',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'provider-secret',
    title: 'Private session',
    cwd: '/Users/ada/mobile-rearch',
    branch: 'mobile-rearch',
    model: null,
    filePath: '/Users/ada/.codex/private.jsonl',
    codexHome: '/Users/ada/.codex',
    createdAt: null,
    updatedAt: '2026-07-26T00:00:00.000Z',
    modifiedAt: '2026-07-26T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 1,
    previewMessages: [{ role: 'assistant', text: 'safe preview', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'private command',
    subagent: null
  }
}

function worktree() {
  return {
    worktreeId: 'host-workspace',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'mobile-rearch',
    displayName: 'mobile-rearch',
    path: '/Users/ada/mobile-rearch',
    liveTerminalCount: 1,
    hasAttachedPty: true,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}
