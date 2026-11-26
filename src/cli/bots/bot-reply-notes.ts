// `orca bot reply --note path:line:text`: the inline notes a reply carries.
import { ConnectorReview } from '../../shared/connector-review-contract'
import type { HandlerContext } from '../dispatch/dispatch'
import { getRepeatedStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

const NOTE = /^(.+?):(\d+):(.+)$/s

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function parseNote(note: string): unknown {
  const match = NOTE.exec(note)
  if (!match) {
    throw invalid(`--note "${note}" must look like path:line:text.`)
  }
  return { path: match[1], line: Number(match[2]), body: match[3] }
}

/** Undefined without --note. */
export function readReplyNotes(flags: HandlerContext['flags']): ConnectorReview | undefined {
  const comments = getRepeatedStringFlag(flags, 'note').map(parseNote)
  if (comments.length === 0) {
    return undefined
  }
  const review = ConnectorReview.safeParse({ comments })
  if (!review.success) {
    const issue = review.error.issues[0]
    throw invalid(
      `Invalid review note${issue.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue.message}`
    )
  }
  return review.data
}
