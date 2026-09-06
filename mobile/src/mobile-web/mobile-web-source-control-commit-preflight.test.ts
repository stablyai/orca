import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  assertFreshMobileWebCommitSnapshot,
  assertMobileWebSourceControlCommitPreflight
} from './mobile-web-source-control-commit-preflight'

const snapshot = {
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

describe('mobile web source-control commit preflight', () => {
  it('accepts only the exact current staged snapshot', () => {
    expect(() =>
      assertMobileWebSourceControlCommitPreflight({
        result: {
          head: snapshot.expectedHead,
          entries: [
            { path: 'src/app.ts', status: 'modified', area: 'staged' },
            { path: 'README.md', status: 'modified', area: 'unstaged' }
          ]
        },
        expectedHead: snapshot.expectedHead,
        stagedEntries: snapshot.stagedEntries
      })
    ).not.toThrow()
  })

  it('rejects changed heads, extra staged entries, unresolved conflicts, and capped status', () => {
    for (const result of [
      {
        head: 'b'.repeat(40),
        entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
      },
      {
        head: snapshot.expectedHead,
        entries: [
          { path: 'src/app.ts', status: 'modified', area: 'staged' },
          { path: 'src/extra.ts', status: 'added', area: 'staged' }
        ]
      },
      {
        head: snapshot.expectedHead,
        entries: [
          {
            path: 'src/app.ts',
            status: 'modified',
            area: 'staged',
            conflictStatus: 'unresolved'
          }
        ]
      },
      {
        head: snapshot.expectedHead,
        entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }],
        didHitLimit: true
      }
    ]) {
      expect(() =>
        assertMobileWebSourceControlCommitPreflight({
          result,
          expectedHead: snapshot.expectedHead,
          stagedEntries: snapshot.stagedEntries
        })
      ).toThrow(expect.objectContaining({ code: 'conflict' }))
    }
  })

  it('reads status through the selected Desktop execution scope', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        head: snapshot.expectedHead,
        entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
      }
    })
    await assertFreshMobileWebCommitSnapshot(
      { sendRequest } as unknown as RpcClient,
      snapshot,
      snapshot.workspaceId
    )
    expect(sendRequest).toHaveBeenCalledWith('git.status', {
      worktree: 'id:workspace-1'
    })
  })
})
