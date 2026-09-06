import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostTaskItemReviewOperations } from './native-host-task-item-review-operations'
import { nativeHostTaskProjectMutationOperations } from './native-host-task-project-mutation-operations'

const ISSUE_ROW = {
  owner: 'orca',
  repo: 'orca',
  host: 'github.com',
  number: 42,
  type: 'issue'
} as const

const PR_ROW = { ...ISSUE_ROW, number: 7, type: 'pr' } as const

function client(sendRequest: RpcClient['sendRequest']): RpcClient {
  return { sendRequest } as unknown as RpcClient
}

describe('native task review comment addressing', () => {
  // Why: an issue row addressed as a PR posts into the wrong conversation on the host.
  it('addresses a project conversation comment by the row type', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: { ok: true }
    })
    const operations = nativeHostTaskProjectMutationOperations(client(sendRequest))

    await operations.addConversationComment(ISSUE_ROW, 'repo-1', 'hi')
    await operations.addConversationComment(PR_ROW, 'repo-1', 'hi')

    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ number: 42, type: 'issue' })
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ number: 7, type: 'pr' })
  })

  // Why: only the server entry carries the numeric id a follow-up reply needs to stay on the
  // same review thread; a locally minted `local-<ts>` id silently downgrades the next reply.
  it('returns the server comment from a project reply instead of dropping it', async () => {
    const comment = { id: 991, body: 'hi', author: 'octocat' }
    const operations = nativeHostTaskProjectMutationOperations(
      client(vi.fn().mockResolvedValue({ ok: true, result: { ok: true, comment } }))
    )

    await expect(
      operations.replyReviewComment(PR_ROW, 'repo-1', { commentId: 5, body: 'hi' })
    ).resolves.toEqual(comment)
    await expect(operations.addConversationComment(ISSUE_ROW, 'repo-1', 'hi')).resolves.toEqual(
      comment
    )
  })

  it('returns the server comment from an item-level review reply', async () => {
    const comment = { id: 992, body: 'hi', author: 'octocat' }
    const operations = nativeHostTaskItemReviewOperations(
      client(vi.fn().mockResolvedValue({ ok: true, result: { ok: true, comment } }))
    )

    await expect(
      operations.replyReviewComment(
        { provider: 'github', repoId: 'repo-1', number: 7, type: 'pr' },
        { commentId: 5, body: 'hi' }
      )
    ).resolves.toEqual(comment)
  })

  it('still raises the host failure message when a reply is refused', async () => {
    const operations = nativeHostTaskItemReviewOperations(
      client(vi.fn().mockResolvedValue({ ok: true, result: { ok: false, error: 'locked' } }))
    )

    await expect(
      operations.replyReviewComment(
        { provider: 'github', repoId: 'repo-1', number: 7, type: 'pr' },
        { commentId: 5, body: 'hi' }
      )
    ).rejects.toThrow('locked')
  })
})
