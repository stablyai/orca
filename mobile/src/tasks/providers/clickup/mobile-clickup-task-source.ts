import type {
  ClickUpTask,
  ClickUpTaskListFilter
} from '../../../../../src/shared/clickup/clickup-types'
import type { UnvalidatedRpcRequestPort } from '../../../transport/rpc/unvalidated-rpc-request-port'
import type { DetailComment, DetailPayload } from '../../mobile-tasks-provider-detail-types'
import { clickUpCommentListSchema } from './clickup-reply-schema'
import {
  clickUpTaskCommentsRead,
  clickUpTaskPageRead,
  clickUpTaskRead,
  clickUpTaskSearchRead
} from './mobile-clickup-operations'

const DETAIL_TIMEOUT_MS = 30_000

export type ClickUpTaskPageResult = { tasks: ClickUpTask[]; nextPage: number | null }

export type ClickUpDetailComment = {
  id: string
  author?: string
  authorAvatarUrl?: string
  body: string
  createdAt?: string
}

/** A comment lands only on the detail of the task it was written to; the open detail may have moved on while the write was out. */
export function appendClickUpComment(
  detail: DetailPayload | null,
  taskId: string,
  comment: DetailComment
): DetailPayload | null {
  return detail?.provider === 'clickup' && detail.taskId === taskId
    ? { ...detail, comments: [...detail.comments, comment] }
    : detail
}

// A search replaces the list and has no further pages; a plain read is paged by the host.
export async function fetchClickUpTaskPage(
  client: UnvalidatedRpcRequestPort,
  args: { query: string; filter: ClickUpTaskListFilter; page: number }
): Promise<ClickUpTaskPageResult> {
  const query = args.query.trim()
  if (query) {
    const tasks = clickUpTaskSearchRead.interpret(
      await clickUpTaskSearchRead.request(client, { query, filter: args.filter })
    )
    return { tasks, nextPage: null }
  }
  const page = clickUpTaskPageRead.interpret(
    await clickUpTaskPageRead.request(client, { filter: args.filter, page: args.page })
  )
  return { tasks: page.tasks, nextPage: page.nextPage }
}

// Optional comments must not hide a readable task.
export function toClickUpDetailComments(result: unknown): ClickUpDetailComment[] {
  const decoded = clickUpCommentListSchema.safeParse(result)
  if (!decoded.success) {
    return []
  }
  return decoded.data.map((comment) => ({
    id: comment.id,
    author: comment.author?.username || undefined,
    authorAvatarUrl: comment.author?.avatarUrl,
    body: comment.body,
    createdAt: comment.createdAt
  }))
}

export async function fetchClickUpTaskDetail(
  client: UnvalidatedRpcRequestPort,
  args: { id: string }
): Promise<{ task: ClickUpTask; comments: ClickUpDetailComment[] }> {
  const [taskReply, commentsReply] = await Promise.all([
    clickUpTaskRead.request(client, args, { timeoutMs: DETAIL_TIMEOUT_MS }),
    clickUpTaskCommentsRead
      .request(client, args, { timeoutMs: DETAIL_TIMEOUT_MS })
      .catch(() => null)
  ])
  const task = clickUpTaskRead.interpret(taskReply)
  if (!task) {
    throw new Error('Details not found')
  }
  let comments: ClickUpDetailComment[] = []
  try {
    if (commentsReply) {
      const decoded = clickUpTaskCommentsRead.interpret(commentsReply)
      comments = toClickUpDetailComments(decoded.accepted ? decoded.value : [])
    }
  } catch {
    // Optional comments must not hide a readable task.
  }
  return { task, comments }
}
