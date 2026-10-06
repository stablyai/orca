import type { PRComment } from '../../shared/github/comment-types'

export type RawBitbucketComment = {
  id: number
  created_on?: string
  updated_on?: string
  content?: {
    raw?: string
    markup?: string
    html?: string
  }
  user?: {
    display_name?: string
    nickname?: string
    account_id?: string
    account_type?: string
    type?: string
    links?: {
      avatar?: { href?: string }
    }
  }
  parent?: {
    id: number
  }
  inline?: {
    path?: string
    to?: number | null
    from?: number | null
    out_dated?: boolean
  }
  deleted?: boolean
  links?: {
    html?: { href?: string }
  }
  resolution?: {
    type?: string
    created_on?: string
    user?: Record<string, unknown>
  } | null
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as {
        error?: { message?: string; detail?: string }
        message?: string
      }
      if (parsed?.error?.message) {
        return parsed.error.detail
          ? `${parsed.error.message}: ${parsed.error.detail}`
          : parsed.error.message
      }
      if (parsed?.message) {
        return parsed.message
      }
    } catch {
      // not JSON
    }
    return error.message
  }
  return String(error)
}

export function findRootCommentId(id: number, parentMap: Map<number, number>): number {
  let current = id
  const visited = new Set<number>([current])
  while (parentMap.has(current)) {
    const parent = parentMap.get(current)!
    if (visited.has(parent)) {
      break
    }
    visited.add(parent)
    current = parent
  }
  return current
}

export function mapBitbucketComment(
  raw: RawBitbucketComment,
  threadRootId?: number,
  inheritedInline?: { path?: string; line?: number; isResolved?: boolean }
): PRComment {
  const author = raw.user?.nickname?.trim() || raw.user?.display_name?.trim() || 'unknown'
  const authorAvatarUrl = raw.user?.links?.avatar?.href || ''
  const body = raw.content?.raw ?? ''
  const createdAt = raw.created_on || ''
  const url = raw.links?.html?.href || ''
  const isBot =
    raw.user?.account_type === 'bot' ||
    raw.user?.type === 'bot' ||
    Boolean(raw.user?.nickname?.endsWith('[bot]'))

  const path = raw.inline?.path ?? inheritedInline?.path
  const line = raw.inline?.to ?? raw.inline?.from ?? inheritedInline?.line ?? undefined
  const isOutdated = raw.inline?.out_dated ?? undefined

  const rootId = threadRootId ?? (raw.parent?.id ? raw.parent.id : raw.id)
  const threadId = String(rootId)
  const isResolved =
    raw.resolution != null || inheritedInline?.isResolved ? true : path ? false : undefined

  return {
    id: raw.id,
    author,
    authorAvatarUrl,
    body,
    createdAt,
    url,
    threadId,
    path,
    line,
    isOutdated,
    isResolved,
    isBot
  }
}

export function mapBitbucketComments(rawComments: readonly RawBitbucketComment[]): PRComment[] {
  const parentMap = new Map<number, number>()
  const rawById = new Map<number, RawBitbucketComment>()
  const parentIdsWithReplies = new Set<number>()

  for (const raw of rawComments) {
    rawById.set(raw.id, raw)
    if (raw.parent?.id) {
      parentMap.set(raw.id, raw.parent.id)
      parentIdsWithReplies.add(raw.parent.id)
    }
  }

  const rootComments = new Map<number, RawBitbucketComment>()
  for (const raw of rawComments) {
    const rootId = findRootCommentId(raw.id, parentMap)
    const root = rawById.get(rootId)
    if (root) {
      rootComments.set(rootId, root)
    }
  }

  const result: PRComment[] = []
  for (const raw of rawComments) {
    if (raw.deleted && !parentIdsWithReplies.has(raw.id)) {
      continue
    }
    const rootId = findRootCommentId(raw.id, parentMap)
    const root = rootComments.get(rootId)
    const isRootResolved = Boolean(root?.resolution != null)
    const inheritedInline =
      root?.inline?.path && !raw.inline?.path
        ? {
            path: root.inline.path,
            line: root.inline.to ?? root.inline.from ?? undefined,
            isResolved: isRootResolved
          }
        : isRootResolved
          ? { isResolved: true }
          : undefined

    result.push(mapBitbucketComment(raw, rootId, inheritedInline))
  }

  return result
}
