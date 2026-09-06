import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebSourceControlOperation } from './mobile-web-source-control-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture()

describe('mobile web source-control operations', () => {
  it('sanitizes and bounds provider-neutral git status', async () => {
    const client = rpcClient({
      branch: 'mobile-rearch',
      head: 'a'.repeat(40),
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/app.ts',
          status: 'modified',
          area: 'unstaged',
          added: 2,
          removed: 1,
          hostPath: '/private/repo/src/app.ts'
        },
        { path: '../secret', status: 'modified', area: 'unstaged' }
      ]
    })
    const result = await executeMobileWebSourceControlOperation({
      operation: 'status',
      payload: { workspaceId: 'workspace-1', limit: 2 },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenCalledWith('git.status', {
      worktree: 'id:workspace-1',
      reuseLineStats: true
    })
    expect(result).toMatchObject({
      workspaceId: 'workspace-1',
      branch: 'mobile-rearch',
      entries: [
        {
          relativePath: 'src/app.ts',
          status: 'modified',
          area: 'unstaged',
          added: 2,
          removed: 1
        }
      ],
      totalCount: 2,
      truncated: true
    })
    expect(JSON.stringify(result)).not.toContain('/private/repo')
  })

  it('returns bounded diff pages and rejects a changed revision continuation', async () => {
    const client = rpcClient({
      kind: 'text',
      originalContent: 'before\nsame\n',
      modifiedContent: 'after\nsame\n'
    })
    const first = await executeMobileWebSourceControlOperation({
      operation: 'diff',
      payload: {
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        area: 'unstaged',
        offset: 0,
        limit: 2
      },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenCalledWith('git.diff', {
      worktree: 'id:workspace-1',
      filePath: 'src/app.ts',
      staged: false
    })
    expect(first).toMatchObject({ kind: 'text', totalRows: 3, nextOffset: 2 })
    expect(JSON.stringify(first)).not.toContain('originalContent')
    if (first.kind !== 'text') {
      throw new Error('Expected text diff')
    }

    client.sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { kind: 'text', originalContent: 'before', modifiedContent: 'changed again' }
    })
    await expect(
      executeMobileWebSourceControlOperation({
        operation: 'diff',
        payload: {
          workspaceId: 'workspace-1',
          relativePath: 'src/app.ts',
          area: 'unstaged',
          offset: 2,
          limit: 2,
          expectedRevision: first.revision
        },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('maps binary and host-limited results without forwarding content', async () => {
    const client = rpcClient({ kind: 'binary', originalContent: 'secret' })
    await expect(
      executeMobileWebSourceControlOperation({
        operation: 'diff',
        payload: {
          workspaceId: 'workspace-1',
          relativePath: 'logo.png',
          area: 'staged',
          offset: 0,
          limit: 20
        },
        client,
        workspaceAuthority
      })
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      relativePath: 'logo.png',
      area: 'staged',
      kind: 'binary'
    })

    client.sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        kind: 'text',
        originalContent: '',
        modifiedContent: '',
        largeDiffRenderLimit: { limited: true, characterCount: 6_000_001 }
      }
    })
    await expect(
      executeMobileWebSourceControlOperation({
        operation: 'diff',
        payload: {
          workspaceId: 'workspace-1',
          relativePath: 'generated.ts',
          area: 'unstaged',
          offset: 0,
          limit: 20
        },
        client,
        workspaceAuthority
      })
    ).resolves.toMatchObject({
      kind: 'too-large',
      reason: 'host-limit',
      characterCount: 6_000_001
    })
  })

  it('preflights and routes bounded single and bulk mutations', async () => {
    const status = {
      head: 'a'.repeat(40),
      entries: [
        { path: 'src/a.ts', status: 'modified', area: 'unstaged' },
        { path: 'src/b.ts', status: 'modified', area: 'unstaged' }
      ]
    }
    const client = rpcClient(status)
    client.sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: status })
      .mockResolvedValueOnce({ ok: true, result: { ok: true } })

    await expect(
      executeMobileWebSourceControlOperation({
        operation: 'stage',
        payload: {
          workspaceId: 'workspace-1',
          expectedHead: 'a'.repeat(40),
          entries: [{ relativePath: 'src/a.ts', status: 'modified', area: 'unstaged' }]
        },
        client,
        workspaceAuthority
      })
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      operation: 'stage',
      relativePaths: ['src/a.ts'],
      mutated: true
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'git.stage', {
      worktree: 'id:workspace-1',
      filePath: 'src/a.ts'
    })

    client.sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: status })
      .mockResolvedValueOnce({ ok: true, result: { ok: true } })
    await executeMobileWebSourceControlOperation({
      operation: 'discard',
      payload: {
        workspaceId: 'workspace-1',
        expectedHead: 'a'.repeat(40),
        confirmation: 'discard-confirmed',
        entries: [
          { relativePath: 'src/a.ts', status: 'modified', area: 'unstaged' },
          { relativePath: 'src/b.ts', status: 'modified', area: 'unstaged' }
        ]
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'git.bulkDiscard', {
      worktree: 'id:workspace-1',
      filePaths: ['src/a.ts', 'src/b.ts']
    })
  })

  it('fails stale mutation preflight before invoking a write RPC', async () => {
    const client = rpcClient({
      head: 'b'.repeat(40),
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }]
    })

    await expect(
      executeMobileWebSourceControlOperation({
        operation: 'stage',
        payload: {
          workspaceId: 'workspace-1',
          expectedHead: 'a'.repeat(40),
          entries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'unstaged' }]
        },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('commits only after an exact staged preflight and returns the new HEAD identity', async () => {
    const previousHead = 'a'.repeat(40)
    const nextHead = 'b'.repeat(40)
    const status = {
      head: previousHead,
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
    }
    const client = rpcClient(status)
    client.sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: status })
      .mockResolvedValueOnce({ ok: true, result: { success: true, hostOutput: '/private/repo' } })
      .mockResolvedValueOnce({ ok: true, result: { head: nextHead, entries: [] } })

    await expect(
      executeMobileWebSourceControlOperation({
        operation: 'commit',
        payload: {
          workspaceId: 'workspace-1',
          expectedHead: previousHead,
          stagedEntries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'staged' }],
          message: '  feat: commit from mobile  '
        },
        client,
        workspaceAuthority
      })
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      previousHead,
      status: 'committed',
      head: nextHead
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'git.commit', {
      worktree: 'id:workspace-1',
      message: 'feat: commit from mobile'
    })
  })

  it('returns a bounded declared commit failure without a false success', async () => {
    const previousHead = 'a'.repeat(40)
    const status = {
      head: previousHead,
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
    }
    const client = rpcClient(status)
    client.sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: status })
      .mockResolvedValueOnce({
        ok: true,
        result: { success: false, error: 'hook rejected the commit', commandOutput: 'secret' }
      })

    await expect(
      executeMobileWebSourceControlOperation({
        operation: 'commit',
        payload: {
          workspaceId: 'workspace-1',
          expectedHead: previousHead,
          stagedEntries: [{ relativePath: 'src/app.ts', status: 'modified', area: 'staged' }],
          message: 'feat: rejected'
        },
        client,
        workspaceAuthority
      })
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      previousHead,
      status: 'failed',
      error: 'hook rejected the commit'
    })
  })
})

function rpcClient(result: unknown): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({ ok: true, result })
  } as unknown as RpcClient
}
