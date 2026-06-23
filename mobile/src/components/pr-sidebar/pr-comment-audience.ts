import type { PRComment } from '../../../../src/shared/types'

// Audience filtering for the PR comment timeline, ported from the desktop helper
// (src/renderer/src/lib/pr-comment-audience.ts) minus its i18n wrapper so it stays
// pure + unit-testable under the node Vitest config. Classification must match the
// desktop so the same comment reads as human/bot on both surfaces.
export type PRCommentAudienceFilter = 'all' | 'human' | 'bot'

export const PR_COMMENT_AUDIENCE_FILTERS: { value: PRCommentAudienceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'human', label: 'Humans' },
  { value: 'bot', label: 'Bots' }
]

const BOT_LOGIN_SUFFIX = '[bot]'
const AUTOMATION_LOGIN_PATTERNS = [
  /bot$/i,
  /-bot$/i,
  /\bbot\b/i,
  /automation/i,
  /actions/i,
  /renovate/i,
  /dependabot/i
]
// Some AI/code-review services use regular user accounts, so GitHub metadata can
// report them as users — keep this list in sync with the desktop helper.
const KNOWN_AUTOMATION_LOGIN_SUBSTRINGS = [
  'chatgpt-codex-connector',
  'codex-connector',
  'qodo',
  'coderabbit',
  'codium',
  'sonarcloud',
  'sonarqube',
  'sourcery-ai',
  'deepsource',
  'snyk',
  'codecov',
  'greptile',
  'ellipsis',
  'graphite-app',
  'reviewer-gpt',
  '-reviewer'
]

export function isBotPRComment(comment: PRComment): boolean {
  if (comment.isBot === true) {
    return true
  }
  const author = comment.author.trim()
  const normalized = author.toLowerCase()
  if (normalized.endsWith(BOT_LOGIN_SUFFIX)) {
    return true
  }
  if (KNOWN_AUTOMATION_LOGIN_SUBSTRINGS.some((needle) => normalized.includes(needle))) {
    return true
  }
  return AUTOMATION_LOGIN_PATTERNS.some((pattern) => pattern.test(author))
}

export function getPRCommentAudienceCounts(
  comments: PRComment[]
): Record<PRCommentAudienceFilter, number> {
  const bot = comments.filter(isBotPRComment).length
  return {
    all: comments.length,
    human: comments.length - bot,
    bot
  }
}

export function filterPRCommentsByAudience(
  comments: PRComment[],
  filter: PRCommentAudienceFilter
): PRComment[] {
  if (filter === 'bot') {
    return comments.filter(isBotPRComment)
  }
  if (filter === 'human') {
    return comments.filter((comment) => !isBotPRComment(comment))
  }
  return comments
}

export function getPRCommentAudienceEmptyLabel(filter: PRCommentAudienceFilter): string {
  switch (filter) {
    case 'bot':
      return 'No bot comments.'
    case 'human':
      return 'No human comments.'
    case 'all':
      return 'No comments yet.'
  }
}
