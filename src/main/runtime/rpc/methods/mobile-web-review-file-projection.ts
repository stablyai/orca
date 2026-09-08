import type { GitLabMRFile } from '../../../../shared/gitlab-types'
import type { GitHubPRFile } from '../../../../shared/github/pull-request-types'
import {
  MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_TOTAL_LINE_LIMIT,
  type MobileWebProviderReview
} from '../../../../shared/mobile-web/provider-review-contract'
import type { MobileWebReviewDetails } from './mobile-web-review-scope'

type ReviewFile = MobileWebProviderReview['files'][number]
type CommentableLines = { values: number[]; truncated: boolean }

export function projectMobileWebReviewFiles(
  details: Extract<MobileWebReviewDetails, { state: 'loaded' }>
): { items: ReviewFile[]; truncated: boolean } {
  return details.provider === 'github'
    ? projectFiles(details.item.files ?? [], gitHubCommentableLines)
    : projectFiles(details.item.files ?? [], gitLabCommentableLines)
}

/** Commentable lines dominate a review's size, so files are admitted until either the file count
 *  or the shared line budget runs out. */
function projectFiles<T extends GitHubPRFile | GitLabMRFile>(
  source: readonly T[],
  commentableLines: (file: T, limit: number) => CommentableLines
): { items: ReviewFile[]; truncated: boolean } {
  const items: ReviewFile[] = []
  let remainingLines = MOBILE_WEB_PROVIDER_REVIEW_TOTAL_LINE_LIMIT
  for (const file of source.slice(0, MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT)) {
    const lines = commentableLines(
      file,
      Math.min(MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT, remainingLines)
    )
    items.push({
      path: file.path,
      ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      isBinary: file.isBinary,
      commentableLines: lines.values,
      commentableLinesTruncated: lines.truncated
    })
    remainingLines -= lines.values.length
  }
  return { items, truncated: source.length > MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT }
}

function gitHubCommentableLines(file: GitHubPRFile, limit: number): CommentableLines {
  const lines = file.reviewCommentLineNumbers ?? []
  return { values: lines.slice(0, limit), truncated: lines.length > limit }
}

/** GitLab answers a unified patch instead of commentable line numbers, so the added and context
 *  lines of each hunk are the only ones a comment may address. */
function gitLabCommentableLines(file: GitLabMRFile, limit: number): CommentableLines {
  return file.diff === undefined
    ? { values: [], truncated: false }
    : modifiedDiffLineNumbers(file.diff, limit)
}

const MAX_GITLAB_DIFF_SCAN_CHARACTERS = 256 * 1024
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

function modifiedDiffLineNumbers(patch: string, limit: number): CommentableLines {
  const scanLimit = Math.min(patch.length, MAX_GITLAB_DIFF_SCAN_CHARACTERS)
  const values: number[] = []
  let nextLine: number | null = null
  let cursor = 0
  while (cursor <= scanLimit) {
    const nextBreak = patch.indexOf('\n', cursor)
    const end = nextBreak === -1 || nextBreak > scanLimit ? scanLimit : nextBreak
    const line = patch.slice(cursor, end)
    const hunk = HUNK_HEADER.exec(line)
    if (hunk) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      nextLine = Number.isInteger(start) && count > 0 ? start : null
    } else if (nextLine !== null && !line.startsWith('\\')) {
      if (line.startsWith('+') || line.startsWith(' ')) {
        if (values.length >= limit) {
          return { values, truncated: true }
        }
        values.push(nextLine)
        nextLine += 1
      } else if (!line.startsWith('-')) {
        nextLine += 1
      }
    }
    if (nextBreak === -1 || nextBreak >= scanLimit) {
      break
    }
    cursor = nextBreak + 1
  }
  return { values, truncated: patch.length > scanLimit }
}
