import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

// The watermark rides alongside the names rather than being expanded into them; a client
// predating the field reads the names only and under-retires the compacted tiers.
const RETIRED = {
  retiredNamesByRepo: { 'repo-1': ['nautilus-2'] },
  retiredNameTiersByRepo: { 'repo-1': 1 }
}

describe('worktree.listRetiredNames', () => {
  it('returns retired names and the compaction watermark, without the worktree listing', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRetiredWorktreeNames: vi.fn().mockResolvedValue(RETIRED)
    } as unknown as OrcaRuntimeService
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.listRetiredNames',
      params: { repo: 'id:repo-1' }
    }

    const response = await new RpcDispatcher({ runtime, methods: WORKTREE_METHODS }).dispatch(
      request
    )

    expect(runtime.listRetiredWorktreeNames).toHaveBeenCalledWith('id:repo-1')
    expect(response).toMatchObject({ ok: true, result: RETIRED })
  })
})
