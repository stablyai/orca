import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'
import { MobileWebAgentHistoryPager } from './mobile-web-agent-history-pager'
import { mobileWebAgentHistoryPreview } from './mobile-web-agent-history-presentation'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web agent-history pager', () => {
  it('projects private host sessions into single-use bounded opaque pages', async () => {
    const sessions = Array.from({ length: 65 }, (_, index) => session(index))
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: ['aiVault.v1'] } }
      }
      if (method === 'worktree.ps') {
        return { ok: true, result: { worktrees: [worktree()] } }
      }
      if (method === 'aiVault.listSessions') {
        return {
          ok: true,
          result: {
            sessions,
            issues: [{ agent: 'codex', path: '/Users/ada/private/bad.jsonl', message: 'raw' }]
          }
        }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const client = { sendRequest } as unknown as RpcClient
    const randomBytes = (length: number) => new Uint8Array(length).fill(3)
    const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
    const workspaceId = workspaceAuthority.registerWorkspace('host-workspace', 'repo-1')
    const sessionAuthority = new MobileWebAgentHistoryAuthority(randomBytes)
    const pager = new MobileWebAgentHistoryPager(randomBytes)

    const first = await pager.page(
      { workspaceId, scope: 'workspace', query: '', force: false },
      client,
      workspaceAuthority,
      sessionAuthority
    )
    expect(first.supported).toBe(true)
    expect(first.sessions).toHaveLength(64)
    expect(first.nextCursor).toMatch(/^agent_history_page_/)
    expect(JSON.stringify(first)).not.toContain('/Users/ada/private')
    expect(JSON.stringify(first)).not.toContain('provider-session-')
    expect(JSON.stringify(first)).not.toContain('resume --secret')
    expect(first.sessions[0]).toMatchObject({
      agent: 'codex',
      agentLabel: 'Codex',
      groupLabel: 'ada/mobile-rearch',
      isCurrentWorkspace: true
    })

    const second = await pager.page(
      {
        workspaceId,
        scope: 'workspace',
        query: '',
        force: false,
        cursor: first.nextCursor!
      },
      client,
      workspaceAuthority,
      sessionAuthority
    )
    expect(second.sessions).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    await expect(
      pager.page(
        {
          workspaceId,
          scope: 'workspace',
          query: '',
          force: false,
          cursor: first.nextCursor!
        },
        client,
        workspaceAuthority,
        sessionAuthority
      )
    ).rejects.toThrow()
  })

  it('returns unsupported without scanning and caps lazy previews', async () => {
    const sendRequest = vi.fn(async () => ({ ok: true, result: { capabilities: [] } }))
    const client = { sendRequest } as unknown as RpcClient
    const randomBytes = (length: number) => new Uint8Array(length)
    const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
    const workspaceId = workspaceAuthority.registerWorkspace('host-workspace', 'repo-1')
    const sessionAuthority = new MobileWebAgentHistoryAuthority(randomBytes)
    const pager = new MobileWebAgentHistoryPager(randomBytes)

    await expect(
      pager.page(
        { workspaceId, scope: 'all', query: '', force: false },
        client,
        workspaceAuthority,
        sessionAuthority
      )
    ).resolves.toEqual({
      supported: false,
      sessions: [],
      skippedTranscriptCount: 0,
      nextCursor: null
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    expect(mobileWebAgentHistoryPreview(session(1)).messages).toHaveLength(5)
  })
})

function session(index: number): AiVaultSession {
  return {
    id: `native-row-${index}`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: `provider-session-${index}`,
    title: `Session ${index}`,
    cwd: '/Users/ada/mobile-rearch',
    branch: 'mobile-rearch',
    model: null,
    filePath: `/Users/ada/private/${index}.jsonl`,
    codexHome: '/Users/ada/.codex',
    createdAt: null,
    updatedAt: `2026-07-26T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    modifiedAt: '2026-07-26T00:00:00.000Z',
    messageCount: 6,
    totalTokens: 10,
    previewMessages: Array.from({ length: 6 }, (_, messageIndex) => ({
      role: messageIndex % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `message ${messageIndex}`,
      timestamp: null
    })),
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'resume --secret',
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
