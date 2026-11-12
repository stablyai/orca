import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { FILE_METHODS } from './files'
import { remoteRpcContentBudget } from '../../../../../shared/remote-rpc-content-budget'

describe('file path search RPC method', () => {
  it('keeps the complete paired Quick Open reply within its content budget', async () => {
    const searchQuickOpenFilePaths = vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      rootPath: '/repo',
      files: Array.from({ length: 32 }, (_, index) => ({
        relativePath: `${'x'.repeat(170_000)}-${index}.ts`,
        basename: `${index}.ts`,
        kind: 'text' as const
      })),
      totalCount: 32,
      truncated: false
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchQuickOpenFilePaths
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const id = 'req-bounded-quick-open'
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      {
        id,
        authToken: 'tok',
        method: 'files.searchPaths',
        params: { worktree: 'id:wt-1', query: 'x', limit: 32, mode: 'quick-open' }
      },
      (response) => replies.push(response),
      { clientKind: 'runtime' }
    )

    const response = JSON.parse(replies.at(-1)!) as {
      ok: boolean
      result: { files: unknown[]; truncated: boolean }
    }
    expect(response.ok).toBe(true)
    expect(response.result.files.length).toBeLessThan(32)
    expect(response.result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(response.result), 'utf8')).toBeLessThanOrEqual(
      remoteRpcContentBudget(id)
    )
  })
})
