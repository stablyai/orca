import '../unused-default-rpc-methods.test-fixture'
// Split from github.test.ts to keep it under its line cap.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GITHUB_METHODS } from './github'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('github.prForBranch refresh reason', () => {
  it('forwards an optional PR refresh reason without requiring it from older clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoPRForBranch: vi.fn().mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    await dispatcher.dispatch(
      makeRequest('github.prForBranch', {
        repo: 'repo-1',
        branch: 'feature/admission',
        reason: 'manual'
      })
    )
    await dispatcher.dispatch(
      makeRequest('github.prForBranch', { repo: 'repo-1', branch: 'feature/legacy' })
    )
    await dispatcher.dispatch(
      makeRequest('github.prForBranch', {
        repo: 'repo-1',
        branch: 'feature/future',
        reason: 'next-generation-refresh'
      })
    )
    await dispatcher.dispatch(
      makeRequest('github.prForBranch', {
        repo: 'repo-1',
        branch: 'main',
        linkedPRNumber: 2383,
        linkedPRRepository: { owner: 'relayto', repo: 'relayto-frontend' }
      })
    )

    expect(runtime.getRepoPRForBranch).toHaveBeenNthCalledWith(
      1,
      'repo-1',
      'feature/admission',
      undefined,
      undefined,
      undefined,
      undefined,
      'manual',
      undefined
    )
    expect(runtime.getRepoPRForBranch).toHaveBeenNthCalledWith(
      2,
      'repo-1',
      'feature/legacy',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(runtime.getRepoPRForBranch).toHaveBeenNthCalledWith(
      3,
      'repo-1',
      'feature/future',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(runtime.getRepoPRForBranch).toHaveBeenNthCalledWith(
      4,
      'repo-1',
      'main',
      2383,
      undefined,
      undefined,
      undefined,
      undefined,
      { owner: 'relayto', repo: 'relayto-frontend' }
    )
  })
})
