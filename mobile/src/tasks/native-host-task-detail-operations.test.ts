import { expect, it, vi } from 'vitest'
import type { RpcRequestSender } from '../transport/rpc-client'
import { nativeHostTaskDetailOperations } from './native-host-task-detail-operations'

it('waits for raw Linear requests so a comments transport rejection wins over an issue refusal', async () => {
  let rejectComments!: (error: Error) => void
  const comments = new Promise<never>((_resolve, reject) => {
    rejectComments = reject
  })
  const sendRequest = vi.fn<RpcRequestSender['sendRequest']>((method) =>
    method === 'linear.getIssue'
      ? Promise.resolve({
          id: 'test',
          _meta: { runtimeId: 'host' },
          ok: false,
          error: { code: 'refused', message: 'issue refused' }
        })
      : comments
  )
  const outcome = nativeHostTaskDetailOperations({ sendRequest })
    .loadLinear({ issueId: 'issue-1', workspaceId: 'workspace-1' })
    .catch((error: unknown) => error)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const commentsError = new Error('comments transport failed')
  rejectComments(commentsError)
  await expect(outcome).resolves.toBe(commentsError)
})
