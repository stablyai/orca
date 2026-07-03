import type { GitHubReaction, GitHubReactionContent, PRComment } from '../../../src/shared/types'
import { isRecord, readBoolean, readNumber, readString } from './github-pr-value-readers'

// Defensive parsers for the PR conversation comments carried by
// github.workItemDetails. Split out of github-pr-parsers to keep that file under
// the 300-line cap. Each returns null / [] on unparseable input rather than throwing.

const REACTION_CONTENTS: ReadonlySet<string> = new Set<GitHubReactionContent>([
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
])

function readReaction(value: unknown): GitHubReaction | null {
  if (!isRecord(value)) {
    return null
  }
  const content = readString(value.content)
  const count = readNumber(value.count)
  if (content === undefined || !REACTION_CONTENTS.has(content) || count === undefined) {
    return null
  }
  return { content: content as GitHubReactionContent, count }
}

function readReactions(value: unknown): GitHubReaction[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const parsed = value.flatMap((entry): GitHubReaction[] => {
    const reaction = readReaction(entry)
    return reaction ? [reaction] : []
  })
  return parsed.length > 0 ? parsed : undefined
}

function readPRComment(value: unknown): PRComment | null {
  if (!isRecord(value)) {
    return null
  }
  const id = readNumber(value.id)
  if (id === undefined) {
    return null
  }
  return {
    id,
    author: readString(value.author) ?? '',
    authorAvatarUrl: readString(value.authorAvatarUrl) ?? '',
    body: readString(value.body) ?? '',
    createdAt: readString(value.createdAt) ?? '',
    url: readString(value.url) ?? '',
    reactions: readReactions(value.reactions),
    path: readString(value.path),
    threadId: readString(value.threadId),
    isResolved: readBoolean(value.isResolved),
    isOutdated: readBoolean(value.isOutdated),
    line: readNumber(value.line),
    startLine: readNumber(value.startLine),
    isBot: readBoolean(value.isBot)
  }
}

// Preserves upstream order — the timeline relies on it for thread grouping.
export function readPRComments(value: unknown): PRComment[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry): PRComment[] => {
    const parsed = readPRComment(entry)
    return parsed ? [parsed] : []
  })
}
