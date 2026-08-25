import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_IMPORT_METHODS } from './worktree-import-methods'

const SELECTOR = 'path:/repo/.claude/worktrees/task'
const worktree = { id: 'repo-1::/repo/.claude/worktrees/task' }

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    importExternalWorktree: vi.fn().mockResolvedValue({ outcome: 'imported', worktree }),
    unimportExternalWorktree: vi.fn().mockResolvedValue({ outcome: 'unimported', worktree })
  } as unknown as OrcaRuntimeService
}

describe('worktree import RPC methods', () => {
  it('routes import and unimport to the runtime by selector', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_IMPORT_METHODS })

    const imported = await dispatcher.dispatch(
      makeRequest('worktree.import', { worktree: SELECTOR })
    )
    const unimported = await dispatcher.dispatch(
      makeRequest('worktree.unimport', { worktree: SELECTOR })
    )

    expect(runtime.importExternalWorktree).toHaveBeenCalledWith(SELECTOR)
    expect(runtime.unimportExternalWorktree).toHaveBeenCalledWith(SELECTOR)
    expect(imported).toMatchObject({ ok: true, result: { outcome: 'imported', worktree } })
    expect(unimported).toMatchObject({ ok: true, result: { outcome: 'unimported', worktree } })
  })

  it('rejects an import without a worktree selector', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_IMPORT_METHODS })

    const response = await dispatcher.dispatch(makeRequest('worktree.import', {}))

    expect(response).toMatchObject({ ok: false })
    expect(runtime.importExternalWorktree).not.toHaveBeenCalled()
  })
})
