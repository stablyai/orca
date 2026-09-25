import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'
import { remoteRpcContentBudget } from '../../../../shared/remote-rpc-content-budget'

describe('file path search RPC method', () => {
  it('returns a bounded server-side result for mobile autocomplete', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchMobileFilePaths: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        rootPath: '/repo',
        files: [{ relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }],
        totalCount: 1,
        truncated: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'files.searchPaths',
      params: { worktree: 'id:wt-1', query: 'app', limit: 8 }
    }

    const response = await dispatcher.dispatch(request)

    expect(runtime.searchMobileFilePaths).toHaveBeenCalledWith('id:wt-1', 'app', 8)
    expect(response).toMatchObject({
      ok: true,
      result: { files: [{ relativePath: 'src/app.ts' }] }
    })
  })

  it('routes desktop Quick Open searches with exclusions and cancellation', async () => {
    const searchQuickOpenFilePaths = vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      rootPath: '/repo',
      files: [{ relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }],
      totalCount: 1,
      truncated: false
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchQuickOpenFilePaths
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const controller = new AbortController()

    const response = await dispatcher.dispatch(
      {
        id: 'req-quick-open',
        authToken: 'tok',
        method: 'files.searchPaths',
        params: {
          worktree: 'id:wt-1',
          query: 'app',
          limit: 8,
          excludePaths: ['/repo/nested'],
          mode: 'quick-open'
        }
      },
      { signal: controller.signal }
    )

    expect(searchQuickOpenFilePaths).toHaveBeenCalledWith(
      'id:wt-1',
      'app',
      8,
      ['/repo/nested'],
      controller.signal
    )
    expect(response).toMatchObject({ ok: true, result: { quickOpenSearchVersion: 1 } })
  })

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
