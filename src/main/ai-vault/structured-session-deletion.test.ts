import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { lstatMock, getHostMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  getHostMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ lstat: lstatMock }))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: getHostMock
}))

import { claudeSessionIdForOrcaSession } from '../claude/claude-session-identity'
import { deleteUnownedClaudeAiVaultSession } from './structured-session-deletion'
import type { AiVaultSessionDeleteAllowedResult } from '../../shared/ai-vault-session-deletion'
import type { AgentSessionStoreExclusiveInspection } from '../runtime/agent-session-store-transaction-queue'

const CLAUDE_ROOT = join('/tmp', 'orca-structured-delete-fixture', '.claude', 'projects')
const OWNED_SESSION = 'orca-session-owned'
const OWNED_TRANSCRIPT = claudeSessionIdForOrcaSession(OWNED_SESSION)

function validation(transcriptId: string): AiVaultSessionDeleteAllowedResult {
  const resolvedPath = join(CLAUDE_ROOT, '-proj', `${transcriptId}.jsonl`)
  return {
    allowed: true,
    agent: 'claude',
    resolvedPath,
    removals: [{ path: resolvedPath, kind: 'file', roots: [CLAUDE_ROOT] }]
  }
}

type FakeRecord = {
  sessionId: string
  provider: 'claude' | 'codex'
  location: { workspaceId: string }
  providerHandleChain: { handle: { provider: 'claude' | 'codex'; sessionId?: string } }[]
}

function claudeRecord(sessionId: string, chain: string[] = []): FakeRecord {
  return {
    sessionId,
    provider: 'claude',
    location: { workspaceId: `ws-${sessionId}` },
    providerHandleChain: chain.map((id) => ({ handle: { provider: 'claude', sessionId: id } }))
  }
}

// Stands in for the record store: `inspect` runs inside what production holds as
// the cross-process transaction lock, so `onEnter` is where a test injects the
// reservation that a check-then-delete would miss.
function hostWith(
  records: FakeRecord[],
  options: { complete?: boolean; onEnter?: () => void; refreshFails?: boolean } = {}
) {
  const visible = records
  return {
    deps: {
      store: {
        withExclusiveHistoryInspection: async <T>(
          act: (inspection: AgentSessionStoreExclusiveInspection) => Promise<T>
        ): Promise<T> => {
          if (options.refreshFails) {
            throw new Error('agent_session_store_corrupt')
          }
          options.onEnter?.()
          return await act({
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries exactly the fields findClaudeTranscriptOwner reads.
            records: visible as unknown as AgentSessionStoreExclusiveInspection['records'],
            complete: options.complete ?? true
          })
        }
      }
    }
  }
}

const admits = { ensureStructuredSessionOwnership: () => Promise.resolve() }

beforeEach(() => {
  vi.clearAllMocks()
  lstatMock.mockResolvedValue({ nlink: 1 })
})

describe('deleteUnownedClaudeAiVaultSession', () => {
  it('removes a transcript no record names', async () => {
    getHostMock.mockReturnValue(hostWith([claudeRecord('other-session')]))
    const remove = vi.fn().mockResolvedValue({ outcome: 'deleted' })

    const result = await deleteUnownedClaudeAiVaultSession(validation('unowned-id'), admits, remove)

    expect(result).toEqual({ outcome: 'deleted' })
    expect(remove).toHaveBeenCalledOnce()
  })

  it('refuses a transcript a live record owns, and removes nothing', async () => {
    getHostMock.mockReturnValue(hostWith([claudeRecord(OWNED_SESSION)]))
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(
      validation(OWNED_TRANSCRIPT),
      admits,
      remove
    )

    expect(result).toEqual({
      outcome: 'rejected',
      agent: 'claude',
      reason: 'structured-session-owned',
      structuredSession: { sessionId: OWNED_SESSION, workspaceId: `ws-${OWNED_SESSION}` }
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses a transcript named only by an earlier link in the handle chain', async () => {
    // A resumed session keeps writing what its earlier links name, so matching
    // the chain head alone would delete history out from under it.
    getHostMock.mockReturnValue(hostWith([claudeRecord('resumed', ['first-id', 'second-id'])]))
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(validation('first-id'), admits, remove)

    expect(result).toMatchObject({ outcome: 'rejected', reason: 'structured-session-owned' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses a reservation that has not been acquired yet', async () => {
    // No handle chain exists before the first spawn, so the deterministic initial
    // identity is the only thing protecting that transcript.
    getHostMock.mockReturnValue(hostWith([claudeRecord(OWNED_SESSION, [])]))
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(
      validation(OWNED_TRANSCRIPT),
      admits,
      remove
    )

    expect(result).toMatchObject({ outcome: 'rejected', reason: 'structured-session-owned' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses rather than reads absence as permission when the catalogue is partial', async () => {
    // A quarantined record could be the owner, so "no match" is not an answer.
    getHostMock.mockReturnValue(hostWith([], { complete: false }))
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(validation('any-id'), admits, remove)

    expect(result).toEqual({
      outcome: 'rejected',
      agent: 'claude',
      reason: 'structured-session-ownership-unknown'
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses when no structured host answers', async () => {
    getHostMock.mockReturnValue(undefined)
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(validation('any-id'), admits, remove)

    expect(result).toMatchObject({ reason: 'structured-session-ownership-unknown' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses when the store cannot be refreshed, before touching anything', async () => {
    getHostMock.mockReturnValue(hostWith([], { refreshFails: true }))
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(validation('any-id'), admits, remove)

    expect(result).toMatchObject({ reason: 'structured-session-ownership-unknown' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses when ensuring the host throws', async () => {
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(
      validation('any-id'),
      { ensureStructuredSessionOwnership: () => Promise.reject(new Error('no host')) },
      remove
    )

    expect(result).toMatchObject({ reason: 'structured-session-ownership-unknown' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('sees a reservation that lands after the request but before the lock', async () => {
    // The point of deciding inside the store's own boundary: a check taken
    // before acquiring it would have read an empty catalogue and deleted.
    const records: FakeRecord[] = []
    getHostMock.mockReturnValue(
      hostWith(records, { onEnter: () => records.push(claudeRecord(OWNED_SESSION)) })
    )
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(
      validation(OWNED_TRANSCRIPT),
      admits,
      remove
    )

    expect(result).toMatchObject({ outcome: 'rejected', reason: 'structured-session-owned' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses a transcript reachable under another name', async () => {
    // A second hard link means this path's id is not the only id for the file,
    // so a clean answer for the path is not an answer for the inode.
    getHostMock.mockReturnValue(hostWith([]))
    lstatMock.mockResolvedValue({ nlink: 2 })
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(validation('unowned-id'), admits, remove)

    expect(result).toMatchObject({ reason: 'structured-session-ownership-unknown' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses when local alias inspection fails', async () => {
    getHostMock.mockReturnValue(hostWith([]))
    lstatMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const remove = vi.fn()

    const result = await deleteUnownedClaudeAiVaultSession(validation('unowned-id'), admits, remove)

    expect(result).toMatchObject({ reason: 'structured-session-ownership-unknown' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps an already-missing transcript idempotent', async () => {
    getHostMock.mockReturnValue(hostWith([]))
    lstatMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    const remove = vi.fn().mockResolvedValue({ outcome: 'deleted' })

    const result = await deleteUnownedClaudeAiVaultSession(validation('unowned-id'), admits, remove)

    expect(result).toEqual({ outcome: 'deleted' })
    expect(remove).toHaveBeenCalledOnce()
  })

  it('does not rely on unreliable host stat for a Windows WSL transcript', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    getHostMock.mockReturnValue(hostWith([]))
    lstatMock.mockRejectedValue(Object.assign(new Error('9P unavailable'), { code: 'EIO' }))
    const remove = vi.fn().mockResolvedValue({ outcome: 'deleted' })
    const target = validation('unowned-id')
    target.resolvedPath = String.raw`\\wsl.localhost\Ubuntu\home\me\.claude\projects\-proj\unowned-id.jsonl`

    try {
      await expect(deleteUnownedClaudeAiVaultSession(target, admits, remove)).resolves.toEqual({
        outcome: 'deleted'
      })
      expect(remove).toHaveBeenCalledOnce()
    } finally {
      platform.mockRestore()
    }
  })

  it('ignores a codex record that happens to carry the same id', async () => {
    getHostMock.mockReturnValue(
      hostWith([{ ...claudeRecord('codex-session'), provider: 'codex' as const }])
    )
    const remove = vi.fn().mockResolvedValue({ outcome: 'deleted' })

    const result = await deleteUnownedClaudeAiVaultSession(
      validation(claudeSessionIdForOrcaSession('codex-session')),
      admits,
      remove
    )

    expect(result).toEqual({ outcome: 'deleted' })
  })
})
