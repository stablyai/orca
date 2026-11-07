import { expect, it } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { startMobileDiffReviewSnapshot } from './mobile-diff-review-snapshot-loader'

it('settles the branch section without a compare when the desktop has no git status', async () => {
  const client = createFakeRpcClient()
  const { branch } = startMobileDiffReviewSnapshot(client, 'repo-1::/tmp/wt', {
    status: Promise.resolve({ kind: 'unavailable' }),
    compareAgainstUpstream: false
  })
  const sent: string[] = []
  // Answer the base-ref reads as they go out; a compare would be the next request.
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const request of client.requests.splice(0)) {
      sent.push(request.method)
      request.resolve(rpcSuccess('reply', { worktree: { baseRef: 'origin/main' }, repos: [] }))
    }
  }
  await expect(branch).resolves.toEqual({ result: null })
  expect(sent).toEqual(['worktree.show', 'repo.list'])
})
