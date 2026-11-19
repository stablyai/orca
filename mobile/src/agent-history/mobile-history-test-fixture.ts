import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'

export function historySession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:provider',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'provider',
    title: 'Current work',
    cwd: '/repo',
    filePath: '/sessions/claude.jsonl',
    codexHome: null,
    branch: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-11-19T00:00:00Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [{ role: 'assistant', text: 'Original context', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

export function historyClient(
  source: AiVaultSession,
  reply?: (method: string, params: unknown) => Promise<RpcResponse | undefined>
) {
  return stubRpcClient({
    sendRequest: async (method, params, options) => {
      options?.beforeSend?.()
      const custom = await reply?.(method, params)
      if (custom) {
        return custom
      }
      const results: Record<string, unknown> = {
        'aiVault.listSessions': { sessions: [source], issues: [] },
        'status.get': {
          hostPlatform: 'darwin',
          capabilities: [
            'agent.launch.v2',
            'agent.launch.replay-required.v1',
            'session.tabs.owned-startup.v1',
            'session.tabs.chat-fork-cli.v1'
          ]
        },
        'repo.list': { repos: [{ id: 'repo', path: '/repo' }] },
        'folderWorkspace.list': { folderWorkspaces: [] },
        'projectGroup.list': { groups: [] },
        'settings.get': { settings: {} },
        'worktree.ps': {
          worktrees: [{ worktreeId: 'repo::/repo', repoId: 'repo', path: '/repo' }]
        },
        'preflight.detectAgents': ['codex'],
        'agent.launchReplay': {
          outcome: {
            kind: 'terminal',
            handle: 'pty',
            paneKey: 'group:11111111-1111-4111-8111-111111111111'
          },
          worktreeId: 'repo::/repo',
          receipt: {
            mode: 'terminal',
            preferred: 'terminal',
            reason: 'user_default',
            detail: 'CLI'
          },
          prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
        }
      }
      if (!(method in results)) {
        throw new Error(`unexpected request: ${method}`)
      }
      return { id: 'reply', ok: true, result: results[method] }
    }
  })
}
