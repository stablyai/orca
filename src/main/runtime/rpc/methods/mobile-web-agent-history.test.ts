import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { RpcContext } from '../core'
import { MOBILE_WEB_AGENT_HISTORY_METHODS } from './mobile-web-agent-history'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'

const [snapshot, preview, resume] = MOBILE_WEB_AGENT_HISTORY_METHODS
const REF = { agent: 'claude', sessionId: 'provider-session-1' }

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'provider-session-1',
    title: 'Fix the parser',
    cwd: '/Users/ada/repo/app',
    codexHome: null,
    filePath: '/Users/ada/.claude/projects/app/session.jsonl',
    messageCount: 4,
    modifiedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    previewMessages: [{ role: 'user', text: 'hello', timestamp: null }],
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  } as AiVaultSession
}

function fixture(sessions: AiVaultSession[] = [session()]) {
  const runtime = {
    getWorktreePs: vi.fn().mockResolvedValue({
      worktrees: [
        {
          worktreeId: 'workspace-1',
          repoId: 'repo-1',
          path: '/Users/ada/repo/app',
          displayName: 'App'
        }
      ]
    }),
    ensureStructuredAgentSessionHost: vi.fn().mockResolvedValue(undefined),
    listAiVaultSessions: vi.fn().mockResolvedValue({ sessions, issues: [{ path: 'broken' }] }),
    listRepos: vi.fn().mockReturnValue([{ id: 'repo-1', path: '/Users/ada/repo' }]),
    enrichMissingRepoGitRemoteIdentities: vi.fn(),
    listProjectGroups: vi.fn().mockReturnValue([]),
    listFolderWorkspaces: vi.fn().mockReturnValue([]),
    getClientSettings: vi.fn().mockReturnValue({}),
    getStatus: vi.fn().mockReturnValue({ hostPlatform: 'darwin' }),
    createMobileSessionTerminal: vi
      .fn()
      .mockResolvedValue({ tab: { id: 'tab-9', terminal: 'private-terminal' } }),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    getDriver: vi.fn().mockReturnValue({}),
    isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true),
    beginMobileInputFloor: vi.fn().mockReturnValue({ rollback: vi.fn(), commit: vi.fn() }),
    sendTerminal: vi
      .fn()
      .mockResolvedValue({ handle: 'private-terminal', accepted: true, bytesWritten: 4 }),
    notifyNativeChatLaunchDraftResolved: vi.fn()
  }
  const context = { runtime, clientId: 'device', pairedDeviceId: 'device' } as unknown as RpcContext
  return { runtime, context }
}

const scope = { worktree: 'id:workspace-1', scope: 'workspace' as const, query: '', force: false }

describe('mobile web agent history', () => {
  it('names sessions by agent and provider id and leaks no host path', async () => {
    const f = fixture()
    const result = (await snapshot.handler(scope, f.context)) as {
      supported: boolean
      sessions: { sessionId: string; agent: string; title: string; isCurrentWorkspace: boolean }[]
      skippedTranscriptCount: number
      nextOffset: number | null
    }
    expect(result.supported).toBe(true)
    expect(result.skippedTranscriptCount).toBe(1)
    expect(result.nextOffset).toBeNull()
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      ...REF,
      title: 'Fix the parser',
      isCurrentWorkspace: true
    })
    // The vault's own row id embeds the transcript path, so the projection must not carry it.
    expect(JSON.stringify(result)).not.toContain('/Users/ada')
    expect(JSON.stringify(result)).not.toContain('.claude/projects')
  })

  it('pages by offset with no server-side cursor', async () => {
    const f = fixture(
      Array.from({ length: 70 }, (_, index) =>
        session({ id: `claude:${index}`, sessionId: `provider-${index}` })
      )
    )
    const first = (await snapshot.handler(scope, f.context)) as {
      sessions: unknown[]
      nextOffset: number | null
    }
    expect(first.sessions).toHaveLength(64)
    expect(first.nextOffset).toBe(64)
    const second = (await snapshot.handler({ ...scope, offset: 64 }, f.context)) as {
      sessions: unknown[]
      nextOffset: number | null
    }
    expect(second.sessions).toHaveLength(6)
    expect(second.nextOffset).toBeNull()
  })

  it('scopes the scan to the addressed worktree', async () => {
    const f = fixture()
    await snapshot.handler(scope, f.context)
    expect(f.runtime.listAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({ scopePaths: ['/Users/ada/repo/app'] })
    )
  })

  it('does not widen a removed workspace to the global history', async () => {
    const f = fixture()
    f.runtime.getWorktreePs.mockResolvedValue({ worktrees: [] })
    await expect(snapshot.handler(scope, f.context)).rejects.toThrow('selector_not_found')
    expect(f.runtime.listAiVaultSessions).not.toHaveBeenCalled()
  })

  it('previews a session the page names, with no prior listing required', async () => {
    const f = fixture()
    expect(await preview.handler({ ...scope, ...REF }, f.context)).toEqual({
      messages: [{ role: 'user', text: 'hello' }]
    })
  })

  it('refuses a session id the scan does not report', async () => {
    const f = fixture()
    await expect(
      preview.handler({ ...scope, ...REF, sessionId: 'not-scanned' }, f.context)
    ).rejects.toThrow('selector_not_found')
  })

  it('picks the most recent transcript when two share a provider id', async () => {
    const f = fixture([
      session({ id: 'claude:old', updatedAt: '2026-01-01T00:00:00.000Z', title: 'Older' }),
      session({ id: 'claude:new', updatedAt: '2026-09-01T00:00:00.000Z', title: 'Newer' })
    ])
    const result = (await resume.handler({ ...scope, ...REF }, f.context)) as { status: string }
    expect(result.status).toBe('queued')
    expect(f.runtime.createMobileSessionTerminal.mock.calls[0]?.[1]?.clientMutationId).toContain(
      'claude:new'
    )
  })

  it('blocks a resume for a session the scan reports with no provider id', async () => {
    const f = fixture([session({ sessionId: ' ' })])
    expect(await resume.handler({ ...scope, agent: 'claude', sessionId: ' ' }, f.context)).toEqual({
      status: 'blocked',
      message: 'This session is missing a resume id.'
    })
    expect(f.runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('creates the resume terminal with its startup command', async () => {
    const f = fixture()
    const result = await resume.handler({ ...scope, ...REF }, f.context)
    expect(result).toEqual({
      status: 'queued',
      targetIsCurrentWorkspace: true,
      targetWorktreeId: 'workspace-1',
      targetWorkspaceName: 'App'
    })
    expect(f.runtime.createMobileSessionTerminal.mock.calls[0]?.[0]).toBe('id:workspace-1')
    expect(f.runtime.createMobileSessionTerminal.mock.calls[0]?.[1]).toMatchObject({
      command: expect.stringContaining('claude'),
      startupCommandDelivery: 'shell-ready'
    })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('forwards cancellation during the history scan to terminal creation', async () => {
    const f = fixture()
    const abort = new AbortController()
    f.context.signal = abort.signal
    f.runtime.listAiVaultSessions.mockImplementationOnce(async () => {
      abort.abort()
      return { sessions: [session()], issues: [] }
    })

    await resume.handler({ ...scope, ...REF }, f.context)

    expect(f.runtime.createMobileSessionTerminal.mock.calls[0]?.[1]).toMatchObject({
      signal: abort.signal
    })
  })

  it('refuses a worktree selector the shell did not write', async () => {
    const f = fixture()
    await expect(snapshot.handler({ ...scope, worktree: 'name:app' }, f.context)).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('reuses one host mutation key so a retried resume does not fork the session', async () => {
    const f = fixture()
    await resume.handler({ ...scope, ...REF }, f.context)
    await resume.handler({ ...scope, ...REF }, f.context)
    const keys = f.runtime.createMobileSessionTerminal.mock.calls.map(
      (call) => (call[1] as { clientMutationId: string }).clientMutationId
    )
    expect(keys[0]).toBe(keys[1])
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('is reachable from a mobile socket', () => {
    for (const method of MOBILE_WEB_AGENT_HISTORY_METHODS) {
      expect(isMobileWebHostRpcMethod(method.name), method.name).toBe(true)
    }
  })
})
