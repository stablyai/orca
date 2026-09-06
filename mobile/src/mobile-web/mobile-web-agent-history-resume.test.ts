import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'
import { MobileWebAgentHistoryResume } from './mobile-web-agent-history-resume'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web agent-history resume', () => {
  it('keeps target resolution and resume commands native while returning an opaque route', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [{ id: 'repo-1', path: '/Users/ada/repo', executionHostId: 'local' }]
          }
        }
      }
      if (method === 'folderWorkspace.list') {
        return { ok: true, result: { folderWorkspaces: [] } }
      }
      if (method === 'projectGroup.list') {
        return { ok: true, result: { groups: [] } }
      }
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'worktree.ps') {
        return { ok: true, result: { worktrees: [worktree()] } }
      }
      if (method === 'status.get') {
        return { ok: true, result: { hostPlatform: 'darwin' } }
      }
      if (method === 'session.tabs.createTerminal') {
        return {
          ok: true,
          result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1', title: 'Terminal' } }
        }
      }
      if (method === 'terminal.send') {
        return { ok: true, result: { send: { accepted: true } } }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const client = { sendRequest } as unknown as RpcClient
    const randomBytes = (length: number) => new Uint8Array(length).fill(9)
    const agentHistoryAuthority = new MobileWebAgentHistoryAuthority(randomBytes)
    const session = hostSession()
    agentHistoryAuthority.synchronize([session])
    const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
    const workspaceId = workspaceAuthority.registerWorkspace('host-workspace', 'repo-1')
    const resume = new MobileWebAgentHistoryResume(randomBytes)

    const result = await resume.resume({
      payload: {
        workspaceId,
        sessionHandle: agentHistoryAuthority.pageHandle(session.id)
      },
      client,
      agentHistoryAuthority,
      workspaceAuthority
    })

    expect(result).toMatchObject({
      status: 'queued',
      targetWorkspaceId: workspaceId,
      targetWorkspaceName: 'mobile-rearch'
    })
    expect(JSON.stringify(result)).not.toContain('/Users/ada')
    expect(JSON.stringify(result)).not.toContain('provider-secret')
    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'pty-1',
        text: expect.stringContaining('provider-secret'),
        enter: true
      },
      { timeoutMs: 30_000 }
    )
  })

  it('preserves the existing blocked result for a missing provider resume id', async () => {
    const sendRequest = vi.fn()
    const client = { sendRequest } as unknown as RpcClient
    const randomBytes = (length: number) => new Uint8Array(length).fill(9)
    const agentHistoryAuthority = new MobileWebAgentHistoryAuthority(randomBytes)
    const session = { ...hostSession(), sessionId: '' }
    agentHistoryAuthority.synchronize([session])
    const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
    const workspaceId = workspaceAuthority.registerWorkspace('host-workspace', 'repo-1')

    await expect(
      new MobileWebAgentHistoryResume(randomBytes).resume({
        payload: {
          workspaceId,
          sessionHandle: agentHistoryAuthority.pageHandle(session.id)
        },
        client,
        agentHistoryAuthority,
        workspaceAuthority
      })
    ).resolves.toEqual({
      status: 'blocked',
      message: 'This session is missing a resume id.'
    })
    expect(sendRequest).not.toHaveBeenCalled()
  })
})

function hostSession(): AiVaultSession {
  return {
    id: 'native-session',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'provider-secret',
    title: 'Private session',
    cwd: '/Users/ada/mobile-rearch',
    branch: 'mobile-rearch',
    model: null,
    filePath: '/Users/ada/.claude/private.jsonl',
    codexHome: null,
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
