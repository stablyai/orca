import { describe, expect, it, vi } from 'vitest'
import {
  GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY,
  GIT_INDEX_PRESERVING_DISCARD_UPDATE_REQUIRED_MESSAGE
} from '../../../src/shared/protocol-version'
import { sendMobileIndexPreservingDiscard } from './mobile-git-index-preserving-discard'

function success(result: unknown) {
  return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('mobile index-preserving discard', () => {
  it('uses the distinct method after capability proof', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(
        success({ capabilities: [GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY] })
      )
      .mockResolvedValueOnce(success({ ok: true }))

    await sendMobileIndexPreservingDiscard({ sendRequest } as never, {
      worktree: 'id:wt-1',
      filePath: 'staged.txt'
    })

    expect(sendRequest.mock.calls).toEqual([
      ['status.get'],
      ['git.discardFromIndex', { worktree: 'id:wt-1', filePath: 'staged.txt' }]
    ])
  })

  it.each([undefined, [], 'git.index-preserving-discard.v1', [42]])(
    'fails closed for absent or malformed capabilities',
    async (capabilities) => {
      const sendRequest = vi.fn().mockResolvedValue(success({ capabilities }))

      await expect(
        sendMobileIndexPreservingDiscard({ sendRequest } as never, {
          worktree: 'id:wt-1',
          filePath: 'staged.txt'
        })
      ).rejects.toThrow(GIT_INDEX_PRESERVING_DISCARD_UPDATE_REQUIRED_MESSAGE)

      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(sendRequest).toHaveBeenCalledWith('status.get')
    }
  )
})
