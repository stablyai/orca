import type {
  LinearCommentAddRequest,
  LinearCommentAddResult,
  LinearCommentDeleteRequest,
  LinearCommentDeleteResult,
  LinearCommentEditRequest,
  LinearCommentEditResult
} from '../../shared/linear/agent-access'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import {
  formatLinearCommentAdd,
  formatLinearCommentDelete,
  formatLinearCommentEdit
} from '../linear-format'
import {
  buildWriteTargetRequest,
  getOptionalWriteId,
  readLinearBody,
  rejectAllWorkspaceForWrite
} from '../linear-request-builders'

const LINEAR_WRITE_TIMEOUT_MS = 75_000

export const LINEAR_COMMENT_WRITE_HANDLERS: Record<string, CommandHandler> = {
  'linear comment add': async ({ flags, client, cwd, json }) => {
    const body = await readLinearBody(flags, cwd, { required: true })
    const request: LinearCommentAddRequest = {
      ...buildWriteTargetRequest(flags, cwd, client.isRemote),
      body,
      replyTo: getOptionalStringFlag(flags, 'reply-to'),
      writeId: getOptionalWriteId(flags)
    }
    const response = await client.call<LinearCommentAddResult>('linear.issueAddComment', request, {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    })
    printResult(response, json, formatLinearCommentAdd)
  },
  'linear comment edit': async ({ flags, client, cwd, json }) => {
    rejectAllWorkspaceForWrite(flags)
    const request: LinearCommentEditRequest = {
      commentId: getRequiredStringFlag(flags, 'id'),
      body: await readLinearBody(flags, cwd, { required: true }),
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    }
    const response = await client.call<LinearCommentEditResult>('linear.commentEdit', request, {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    })
    printResult(response, json, formatLinearCommentEdit)
  },
  'linear comment delete': async ({ flags, client, json }) => {
    rejectAllWorkspaceForWrite(flags)
    const request: LinearCommentDeleteRequest = {
      commentId: getRequiredStringFlag(flags, 'id'),
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    }
    const response = await client.call<LinearCommentDeleteResult>('linear.commentDelete', request, {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    })
    printResult(response, json, formatLinearCommentDelete)
  }
}
