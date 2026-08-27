import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'

export type CodexWorkerThreadRequest = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>

export type CodexWorkerThreadNameResult =
  | { state: 'named' | 'already_named' }
  | { state: 'user_named'; observedName: string }

const CODEX_WORKER_THREAD_NAME_MAX_LENGTH = 64

export function buildCodexWorkerThreadName(input: {
  spec: string
  taskTitle?: string | null
  displayName?: string | null
}): string {
  const metadata = buildOrchestrationTaskDisplayMetadata(input)
  return truncateSidebarName(metadata.taskTitle || metadata.displayName)
}

export async function applyCodexWorkerThreadName(args: {
  threadId: string
  desiredName: string
  request: CodexWorkerThreadRequest
}): Promise<CodexWorkerThreadNameResult> {
  const result = (await args.request('thread/read', { threadId: args.threadId })) as {
    thread?: { id?: unknown; name?: unknown }
  }
  if (result.thread?.id !== args.threadId) {
    throw new Error(`Codex returned a different thread while naming ${args.threadId}.`)
  }
  const observedName = result.thread.name
  if (typeof observedName === 'string' && observedName.length > 0) {
    return observedName === args.desiredName
      ? { state: 'already_named' }
      : { state: 'user_named', observedName }
  }
  await args.request('thread/name/set', {
    threadId: args.threadId,
    name: args.desiredName
  })
  return { state: 'named' }
}

export async function archiveCodexWorkerThread(args: {
  threadId: string
  request: CodexWorkerThreadRequest
}): Promise<{ state: 'archived' | 'already_archived' }> {
  try {
    await args.request('thread/archive', { threadId: args.threadId })
    return { state: 'archived' }
  } catch (error) {
    if (await threadListContains(args.request, args.threadId, true)) {
      return { state: 'already_archived' }
    }
    throw error
  }
}

async function threadListContains(
  request: CodexWorkerThreadRequest,
  threadId: string,
  archived: boolean
): Promise<boolean> {
  let cursor: string | undefined
  do {
    const response = (await request('thread/list', {
      archived,
      limit: 100,
      sortKey: 'updated_at',
      ...(cursor ? { cursor } : {})
    })) as {
      data?: { id?: unknown }[]
      nextCursor?: string | null
    }
    if (response.data?.some((thread) => thread.id === threadId)) {
      return true
    }
    cursor = typeof response.nextCursor === 'string' ? response.nextCursor : undefined
  } while (cursor)
  return false
}

function truncateSidebarName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length <= CODEX_WORKER_THREAD_NAME_MAX_LENGTH) {
    return normalized
  }
  const body = trimDanglingHighSurrogate(
    normalized.slice(0, CODEX_WORKER_THREAD_NAME_MAX_LENGTH - 3)
  ).trimEnd()
  return `${body}...`
}

function trimDanglingHighSurrogate(value: string): string {
  const lastCode = value.charCodeAt(value.length - 1)
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? value.slice(0, -1) : value
}
