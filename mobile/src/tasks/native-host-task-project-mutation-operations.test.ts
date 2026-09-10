import { describe, expect, it, vi } from 'vitest'
import type { RpcRequestSender } from '../transport/rpc-client'
import type { HostTaskProjectMutationOperations } from './host-task-project-mutation-operations'
import { nativeHostTaskProjectMutationOperations } from './native-host-task-project-mutation-operations'

const target = { owner: 'orca', repo: 'orca', host: 'github.com', number: 7, type: 'pr' as const }
const mutations: Array<
  [string, (ops: HostTaskProjectMutationOperations) => Promise<unknown>, string]
> = [
  [
    'updateItem',
    (ops) => ops.updateItem(target, { title: 'title' }),
    'Failed to update GitHub item'
  ],
  [
    'updateIssue',
    (ops) => ops.updateItem({ ...target, type: 'issue' }, {}),
    'Failed to update GitHub item'
  ],
  ['updateComment', (ops) => ops.updateComment(target, 1, 'body'), 'Failed to edit comment'],
  ['deleteComment', (ops) => ops.deleteComment(target, 1), 'Failed to delete comment'],
  ['updateMetadata', (ops) => ops.updateMetadata(target, {}), 'Failed to update GitHub item'],
  [
    'updateField',
    (ops) =>
      ops.updateField({ ...target, projectId: 'p', itemId: 'i' }, 'f', {
        kind: 'text',
        text: 'value'
      }),
    'Failed to update project field'
  ],
  [
    'clearField',
    (ops) => ops.updateField({ ...target, projectId: 'p', itemId: 'i' }, 'f', null),
    'Failed to update project field'
  ],
  ['updateIssueType', (ops) => ops.updateIssueType(target, null), 'Failed to update issue type'],
  [
    'replyReviewComment',
    (ops) => ops.replyReviewComment(target, 'repo-1', { commentId: 1, body: 'body' }),
    'Failed to reply'
  ],
  [
    'addConversationComment',
    (ops) => ops.addConversationComment(target, 'repo-1', 'body'),
    'Failed to reply'
  ],
  [
    'requestReviewers',
    (ops) => ops.requestReviewers(target, 'repo-1', ['reviewer']),
    'Failed to request reviewers'
  ],
  [
    'rerunChecks',
    (ops) => ops.rerunChecks(target, 'repo-1', { failedOnly: true }),
    'Failed to rerun checks'
  ],
  ['merge', (ops) => ops.merge(target, 'repo-1', 'squash'), 'Failed to merge pull request']
]

function operations(result: unknown) {
  const sendRequest = vi
    .fn<RpcRequestSender['sendRequest']>()
    .mockResolvedValue({ id: 'test', _meta: { runtimeId: 'host' }, ok: true, result })
  return nativeHostTaskProjectMutationOperations({ sendRequest })
}

describe('Project mutation result acceptance', () => {
  it.each(mutations)(
    '%s rejects absent results, accepts missing ok, and reports refusal',
    async (_name, mutate, fallback) => {
      for (const result of [null, undefined]) {
        await expect(mutate(operations(result))).rejects.toBeInstanceOf(TypeError)
      }
      for (const result of [{}, { ok: undefined }, { ok: true }]) {
        await expect(mutate(operations(result))).resolves.toBeUndefined()
      }
      await expect(mutate(operations({ ok: false }))).rejects.toThrow(fallback)
    }
  )

  it('addComment requires truthy ok and preserves the host message', async () => {
    for (const result of [null, undefined]) {
      await expect(operations(result).addComment(target, 'body')).rejects.toBeInstanceOf(TypeError)
    }
    for (const result of [{}, { ok: undefined }, { ok: false }]) {
      await expect(operations(result).addComment(target, 'body')).rejects.toThrow(
        'Failed to add comment'
      )
    }
    await expect(
      operations({ ok: false, error: { message: 'host refusal' } }).addComment(target, 'body')
    ).rejects.toThrow('host refusal')
    await expect(operations({ ok: true }).addComment(target, 'body')).resolves.toBeUndefined()
  })

  it('merge preserves its string refusal', async () => {
    await expect(
      operations({ ok: false, error: 'merge refusal' }).merge(target, 'repo-1', 'merge')
    ).rejects.toThrow('merge refusal')
  })

  it('resolveReviewThread requires the literal true result', async () => {
    for (const result of [null, undefined, {}, { ok: true }, false]) {
      await expect(
        operations(result).resolveReviewThread(target, 'repo-1', 'thread', true)
      ).rejects.toThrow('Failed to resolve thread')
    }
    await expect(
      operations(true).resolveReviewThread(target, 'repo-1', 'thread', true)
    ).resolves.toBeUndefined()
  })
})
