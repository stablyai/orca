import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
import { createMobileAiVaultResumeMutationRegistry } from './ai-vault-resume-launch'
import { continueMobileHistorySession } from './mobile-history-session-continuation'

const source: AiVaultSession = {
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
  previewMessages: [
    { role: 'assistant', text: 'Changed the login flow; tests remain.', timestamp: null }
  ],
  lastUserPrompt: 'Fix login',
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
}

describe('mobile history handoff', () => {
  it.each(['handed-to-terminal', 'unconfirmed'] as const)(
    'carries conversation context through the durable host launch (%s)',
    async (outcome) => {
      let launchedPrompt: unknown
      const client = stubRpcClient({
        sendRequest: async (method, params) => {
          const results: Record<string, unknown> = {
            'status.get': {
              hostPlatform: 'darwin',
              capabilities: ['agent.launch.v2', 'agent.launch.replay-required.v1']
            },
            'repo.list': { repos: [{ id: 'repo', path: '/repo' }] },
            'folderWorkspace.list': { folderWorkspaces: [] },
            'projectGroup.list': { groups: [] },
            'settings.get': {},
            'worktree.ps': { worktrees: [{ worktreeId: 'route', repoId: 'repo', path: '/repo' }] },
            'agent.launchReplay': {
              outcome: {
                kind: 'terminal',
                handle: 'pty',
                paneKey: 'group:11111111-1111-4111-8111-111111111111'
              },
              worktreeId: 'route',
              receipt: {
                mode: 'terminal',
                preferred: 'terminal',
                reason: 'user_default',
                detail: 'CLI'
              },
              prompt: { delivery: 'submit', outcome }
            }
          }
          if (method === 'agent.launchReplay') {
            expect(params).toMatchObject({
              agent: 'codex',
              target: { kind: 'existing', worktree: 'id:route' }
            })
            if (params && typeof params === 'object' && 'prompt' in params) {
              launchedPrompt = params.prompt
            }
          }
          if (!(method in results)) {
            throw new Error(`unexpected request: ${method}`)
          }
          return { id: 'reply', ok: true, result: results[method] }
        }
      })
      const result = continueMobileHistorySession({
        client,
        session: source,
        action: { kind: 'handoff', agent: 'codex', worktreeId: 'route' },
        worktreeId: 'route',
        worktrees: [],
        assertCurrentOwner: () => {},
        mutations: createMobileAiVaultResumeMutationRegistry(() => 'handoff-operation'),
        handoffs: new Map()
      })
      if (outcome === 'unconfirmed') {
        await expect(result).resolves.toMatchObject({
          worktreeId: 'route',
          terminal: 'pty',
          paneKey: 'group:11111111-1111-4111-8111-111111111111',
          warning: expect.stringContaining('context delivery was not confirmed')
        })
      } else {
        await expect(result).resolves.toEqual({
          worktreeId: 'route',
          paneKey: 'group:11111111-1111-4111-8111-111111111111',
          terminal: 'pty'
        })
      }
      expect(launchedPrompt).toMatchObject({
        delivery: 'submit',
        text: expect.stringContaining('Changed the login flow; tests remain.')
      })
    }
  )
})
