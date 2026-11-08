import '../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import '../../../../../shared/protocol-version'
import '../../../../../shared/worktree-runtime-capabilities'

import '../../../../../shared/electron-remote-runtime-client-capabilities'

describe('worktree explicit acknowledgement RPC', () => {
  it.each([false, true])(
    'publishes a captured read only after metadata succeeds: %s',
    async (fails) => {
      const acknowledgement = {
        reads: [{ sessionId: 'session-1', observedCursor: { epoch: 'journal-1', sequence: 5 } }]
      }
      const publish = vi.fn()
      let captured = false
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every runtime method this request reaches.
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        prepareWorkspaceAttentionAcknowledgement: async () => {
          captured = true
          return acknowledgement
        },
        updateManagedWorktreeMeta: async () => {
          expect(captured).toBe(true)
          expect(publish).not.toHaveBeenCalled()
          if (fails) {
            throw new Error('metadata write failed')
          }
          return { id: 'wt-1' }
        },
        acknowledgeNotificationAttention: publish
      } as unknown as OrcaRuntimeService

      const response = await new RpcDispatcher({ runtime, methods: WORKTREE_METHODS }).dispatch({
        id: 'req-read',
        authToken: 'tok',
        method: 'worktree.set',
        params: { worktree: 'id:wt-1', isUnread: false, acknowledgeAttention: true }
      })

      expect(response).toMatchObject({ ok: !fails })
      if (fails) {
        expect(publish).not.toHaveBeenCalled()
      } else {
        expect(publish).toHaveBeenCalledExactlyOnceWith(acknowledgement)
      }
    }
  )
})

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
