/**
 * #12547: `files.listAll` did not declare `maxResults`, so "the client names its cap and a full page
 * means there is more" was wired only on the Electron IPC hop. Web and mobile were saved incidentally,
 * by `remoteFileContentBudget` defaulting the cap inside `listRuntimeFiles`.
 */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('files.listAll page size', () => {
  // Why #12547: `maxResults` was wired only on the Electron IPC hop, so "a full page means there is
  // more" was true for a desktop client and incidental for web/mobile. Declaring it here is a new
  // optional field (wire rule 1): an older host strips it and keeps its own default.
  it('forwards a client-named page size for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRuntimeFiles: vi.fn().mockResolvedValue(['src/index.ts'])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.listAll', { worktree: 'id:wt-1', maxResults: 20_001 })
    )

    expect(runtime.listRuntimeFiles).toHaveBeenCalledWith('id:wt-1', {
      excludePaths: undefined,
      maxResults: 20_001
    })
    expect(response).toMatchObject({ ok: true, result: ['src/index.ts'] })
  })

  // Why refuse rather than fall back: no released client sends this field, so a malformed value is a
  // bug in the caller, not skew — the same call `files.search` already makes for its own maxResults.
  it('refuses a malformed page size instead of silently picking one', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRuntimeFiles: vi.fn().mockResolvedValue(['src/index.ts'])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.listAll', { worktree: 'id:wt-1', maxResults: -3 })
    )

    expect(response).toMatchObject({ ok: false })
  })
})
