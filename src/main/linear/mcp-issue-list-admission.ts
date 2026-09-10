import { createHash } from 'node:crypto'
import type { LinearMcpIssueListResult } from '../../shared/linear/mcp-issue-list'
import {
  stringifyJsonWithinByteLimit,
  JsonStringifyByteLimitError
} from '../../shared/node-bounded-json-stringify'
import { linearError } from './issue-context-errors'

export const LIST_ISSUE_BYTES = 896 * 1024
export type ListedIssue = LinearMcpIssueListResult['issues'][number]
export class IssueListAdmission {
  readonly issues: ListedIssue[] = []
  private bytes = 0
  private readonly identities = new Set<string>()
  private readonly cursors = new Set<string>()
  private progressBytes = 0

  get remainingBytes(): number {
    return LIST_ISSUE_BYTES - this.bytes
  }

  stage(
    rows: ListedIssue[],
    cursorIdentity?: string
  ): { bytes: number; commit: () => void } | null {
    let bytes = 0
    const identities = rows.map((row) => digest(JSON.stringify([row.workspace.id, row.id])))
    if (
      new Set(identities).size !== identities.length ||
      identities.some((key) => this.identities.has(key))
    ) {
      throw linearError(
        'linear_list_invalid_response',
        'Linear returned duplicate or conflicting issue identities.'
      )
    }
    const cursor = cursorIdentity === undefined ? undefined : digest(cursorIdentity)
    if (cursor && this.cursors.has(cursor)) {
      throw linearError('linear_list_cursor_cycle', 'Linear returned a repeated provider cursor.')
    }
    const progressBytes = (identities.length + (cursor ? 1 : 0)) * 64
    if (this.progressBytes + progressBytes > 64 * 1024) {
      throw linearError(
        'linear_list_metadata_capacity',
        'Linear progress metadata capacity reached; resume from the returned position.'
      )
    }
    try {
      for (const row of rows) {
        const wrapper = { result: { issues: [row] } }
        bytes += Math.max(
          stringifyJsonWithinByteLimit(wrapper, LIST_ISSUE_BYTES).byteLength,
          stringifyJsonWithinByteLimit(wrapper, LIST_ISSUE_BYTES, 2).byteLength + 1
        )
      }
    } catch (error) {
      if (error instanceof JsonStringifyByteLimitError) {
        return null
      }
      throw error
    }
    if (bytes > this.remainingBytes) {
      return null
    }
    return {
      bytes,
      commit: () => {
        this.issues.push(...rows)
        this.bytes += bytes
        this.progressBytes += progressBytes
        identities.forEach((key) => this.identities.add(key))
        if (cursor) {
          this.cursors.add(cursor)
        }
      }
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
