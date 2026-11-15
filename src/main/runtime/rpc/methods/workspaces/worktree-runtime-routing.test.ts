import '../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import '../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'

import '../../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'

describe('worktree.rm host qualification', () => {
  function makeRuntime(repoHostIds: (string | undefined)[] = ['local']): OrcaRuntimeService {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every runtime member reached by the requests in this suite.
    return {
      getRuntimeId: () => 'test-runtime',
      listRepos: () =>
        repoHostIds.map((executionHostId) => ({
          id: 'repo-1',
          path: '/repo',
          executionHostId
        })),
      showManagedWorktree: vi.fn().mockResolvedValue({ id: 'wt-1', hostId: 'local' }),
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
  }

  const WORKTREE_ID = 'repo-1::/repo/wt'

  function makeRequest(params: unknown): RpcRequest {
    return { id: 'req-1', authToken: 'tok', method: 'worktree.rm', params }
  }

  it('fails closed when the repo id carries both spellings', async () => {
    const runtime = makeRuntime(['local', 'runtime:env-1'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'runtime:env-1',
        force: true,
        runHooks: false
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('ambiguous across hosts') }
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })
})
