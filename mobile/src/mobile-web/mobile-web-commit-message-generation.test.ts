import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCommitMessageGeneration } from './mobile-web-commit-message-generation'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture()

const payload = {
  workspaceId: 'workspace-1',
  expectedHead: 'a'.repeat(40),
  stagedEntries: [
    {
      relativePath: 'src/app.ts',
      status: 'modified' as const,
      area: 'staged' as const
    }
  ]
}

describe('mobile web commit-message generation', () => {
  it('preflights twice and returns only a bounded generated result', async () => {
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'git.status') {
        return Promise.resolve({ ok: true, result: status() })
      }
      return Promise.resolve({
        ok: true,
        result: {
          success: true,
          message: 'feat: generated',
          agentLabel: 'Codex',
          commandOutput: '/private/repo'
        }
      })
    })
    const generation = new MobileWebCommitMessageGeneration()

    await expect(
      generation.generate({
        requestId: 'A'.repeat(22),
        payload,
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority
      })
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      previousHead: payload.expectedHead,
      status: 'generated',
      message: 'feat: generated',
      agentLabel: 'Codex'
    })
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'git.generateCommitMessage',
      {
        worktree: 'id:workspace-1'
      },
      {
        timeoutMs: 65_000
      }
    )
    expect(sendRequest.mock.calls.filter(([method]) => method === 'git.status')).toHaveLength(2)
  })

  it('rejects a generated draft when the staged snapshot changes during generation', async () => {
    let statusReads = 0
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'git.status') {
        statusReads += 1
        return Promise.resolve({
          ok: true,
          result:
            statusReads === 1
              ? status()
              : {
                  head: payload.expectedHead,
                  entries: [
                    { path: 'src/app.ts', status: 'modified', area: 'staged' },
                    { path: 'src/extra.ts', status: 'added', area: 'staged' }
                  ]
                }
        })
      }
      return Promise.resolve({ ok: true, result: { success: true, message: 'stale draft' } })
    })

    await expect(
      new MobileWebCommitMessageGeneration().generate({
        requestId: 'A'.repeat(22),
        payload,
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('routes request and client-replacement cancellation to the originating client', async () => {
    let resolveGeneration: ((value: unknown) => void) | undefined
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'git.status') {
        return Promise.resolve({ ok: true, result: status() })
      }
      if (method === 'git.generateCommitMessage') {
        return new Promise((resolve) => {
          resolveGeneration = resolve
        })
      }
      return Promise.resolve({ ok: true, result: { ok: true } })
    })
    const client = { sendRequest } as unknown as RpcClient
    const generation = new MobileWebCommitMessageGeneration()
    const pending = generation.generate({
      requestId: 'A'.repeat(22),
      payload,
      client,
      workspaceAuthority
    })
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'git.generateCommitMessage',
        { worktree: 'id:workspace-1' },
        { timeoutMs: 65_000 }
      )
    )

    generation.replaceClient({ sendRequest: vi.fn() } as unknown as RpcClient)
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith('git.cancelGenerateCommitMessage', {
        worktree: 'id:workspace-1'
      })
    )
    resolveGeneration?.({ ok: true, result: { success: true, message: 'late draft' } })
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  })
})

function status() {
  return {
    head: payload.expectedHead,
    entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
  }
}
