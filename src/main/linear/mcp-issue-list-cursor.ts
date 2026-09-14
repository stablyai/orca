import { linearError } from './issue-context-errors'

export const ISSUE_LIST_CURSOR_PREFIX = 'orca.linear.v1.'

export function encodeIssueListCursor(workspaceId: string, providerCursor: string): string {
  return (
    ISSUE_LIST_CURSOR_PREFIX +
    Buffer.from(JSON.stringify({ workspaceId, cursor: providerCursor }), 'utf8').toString(
      'base64url'
    )
  )
}

export function decodeIssueListCursor(
  value: string
): { workspaceId: string; cursor: string } | null {
  if (!value.startsWith(ISSUE_LIST_CURSOR_PREFIX)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(ISSUE_LIST_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    )
    if (
      parsed &&
      typeof parsed === 'object' &&
      'workspaceId' in parsed &&
      'cursor' in parsed &&
      typeof parsed.workspaceId === 'string' &&
      typeof parsed.cursor === 'string' &&
      // A hand-crafted payload must not smuggle back the fan-out selector or an empty
      // workspace, both of which would silently widen the read past the bound workspace.
      parsed.workspaceId !== 'all' &&
      parsed.workspaceId.length > 0 &&
      parsed.cursor.length > 0
    ) {
      return { workspaceId: parsed.workspaceId, cursor: parsed.cursor }
    }
  } catch {
    // Prefix matched but payload is not ours; treat as an invalid issued cursor.
  }
  return null
}

export function resolveIssueListCursor(request: {
  cursor?: string
  workspaceId?: (string & {}) | 'all'
}): { workspaceId?: (string & {}) | 'all'; linearCursor?: string } {
  const cursor = request.cursor
  if (!cursor) {
    return { workspaceId: request.workspaceId }
  }
  if (request.workspaceId === 'all') {
    throw cursorWorkspaceError(
      'Cursor pagination cannot use --workspace all.',
      'Pass a concrete --workspace or reuse an issued list-issues nextCursor without --workspace all.'
    )
  }
  const issued = decodeIssueListCursor(cursor)
  if (issued) {
    if (request.workspaceId && request.workspaceId !== issued.workspaceId) {
      throw cursorWorkspaceError(
        'Cursor workspace does not match --workspace.',
        `Use --workspace ${issued.workspaceId} or omit --workspace to reuse the issued cursor.`
      )
    }
    return { workspaceId: issued.workspaceId, linearCursor: issued.cursor }
  }
  if (cursor.startsWith(ISSUE_LIST_CURSOR_PREFIX)) {
    throw cursorWorkspaceError(
      'Cursor was issued by Orca but is malformed or truncated.',
      'Re-run list-issues without --cursor, then page with the nextCursor it returns.'
    )
  }
  if (!request.workspaceId) {
    throw cursorWorkspaceError(
      'Cursor pagination requires a concrete Linear workspace.',
      'Pass --workspace with result.meta.workspaceId from the previous list-issues page.',
      'Or reuse nextCursor from a current list-issues page, which binds the workspace.'
    )
  }
  return { workspaceId: request.workspaceId, linearCursor: cursor }
}

function cursorWorkspaceError(message: string, ...nextSteps: string[]) {
  return linearError('linear_invalid_workspace', message, { nextSteps })
}
