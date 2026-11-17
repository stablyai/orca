import { describe, expect, it } from 'vitest'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY } from '../../../../src/shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { runReviewedCreatedSetup } from './created-worktree-setup-review'
import { createWorktreeWithNameRetry } from './worktree-create-retry'

function reply(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('created workspace setup review', () => {
  it('reports setup the host skipped because the created branch differs', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(
      reply({
        worktree: { id: 'wt-1', displayName: 'marlin' },
        setupTrustMismatch: { contentHash: 'branch-hash', scriptContent: 'make branch' }
      })
    )
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'marlin',
      worktreeCreateIdempotency: Promise.resolve(false),
      approvedSetupHash: 'shown-hash',
      buildParams: (name) => ({ repo: 'id:repo-1', name, setupDecision: 'run' })
    })
    expect(client.sendRequest.mock.calls[0]?.[1]).toMatchObject({ approvedSetupHash: 'shown-hash' })
    expect(result).toMatchObject({
      worktreeId: 'wt-1',
      setupTrustMismatch: { contentHash: 'branch-hash', scriptContent: 'make branch' }
    })
  })

  it('runs only the reviewed content in the created workspace', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method: string) =>
      method === 'status.get'
        ? reply({ capabilities: [WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY] })
        : reply({ status: 'started' })
    )
    await expect(runReviewedCreatedSetup(client, 'wt-1', 'branch-hash')).resolves.toBeUndefined()
    expect(client.sendRequest).toHaveBeenCalledWith('worktree.runApprovedSetup', {
      worktree: 'id:wt-1',
      approvedSetupHash: 'branch-hash'
    })
  })
})
