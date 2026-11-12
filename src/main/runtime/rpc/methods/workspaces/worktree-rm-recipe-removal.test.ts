import '../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { classifyRuntimeLongPoll } from '../../server/runtime-rpc-long-poll'

const WORKTREE_ID = 'repo-1::/repo/wt'

describe('worktree.rm long-poll admission', () => {
  const request = { id: 'req', authToken: 'tok', method: 'worktree.rm' }
  it('keeps a recipe workspace removal alive while its destroy runs', () => {
    expect(
      classifyRuntimeLongPoll({
        ...request,
        params: { worktree: `id:${WORKTREE_ID}`, hostId: 'runtime:env-a', destroyHost: true }
      })
    ).toBe('wait')
  })
  it('leaves ordinary removals as short calls', () => {
    expect(
      classifyRuntimeLongPoll({ ...request, params: { worktree: 'name:task', hostId: 'local' } })
    ).toBeNull()
    expect(
      classifyRuntimeLongPoll({
        ...request,
        params: { worktree: `id:${WORKTREE_ID}`, hostId: 'runtime:env-a' }
      })
    ).toBeNull()
  })
})
