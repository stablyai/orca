import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GITHUB_REPO_WORK_ITEM_METHODS } from './github-repo-work-item-methods'

// Actions trusts only verified SSH origins, so the RPC must forward the probe requirement.
it('forwards verified SSH probe requests for repo slugs', async () => {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getRepoSlug: vi.fn().mockResolvedValue({ owner: 'acme', repo: 'orca' })
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_REPO_WORK_ITEM_METHODS })

  await dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'github.repoSlug',
    params: { repo: 'repo-1', requireVerifiedSshProbe: true }
  })

  expect(runtime.getRepoSlug).toHaveBeenLastCalledWith('repo-1', { requireVerifiedSshProbe: true })
})
