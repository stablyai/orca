import type { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'
import type {
  CLAUDE_PROFILE_RESOURCE_DIRS,
  CLAUDE_PROFILE_RESOURCE_FILES
} from './claude-profile-provisioning'

export type ClaudeProfileSurface =
  | 'profile'
  | (typeof CLAUDE_PROFILE_HISTORY_DIRS)[number]
  | 'history.jsonl'
  | (typeof CLAUDE_PROFILE_RESOURCE_DIRS)[number]
  | (typeof CLAUDE_PROFILE_RESOURCE_FILES)[number]
  | 'settings.json'
  | '.claude.json'
  | 'ledger'
  | 'hooks'

export type ClaudeProfileSurfaceOutcome =
  | 'linked'
  | 'synced'
  | 'merged'
  | 'unchanged'
  | 'user-owned'
  | 'absent'
  | 'failed'

/** Closed so callers branch on a code, never on message text. */
export type ClaudeProfileWarningCode =
  | 'invalid-profile'
  | 'unreadable'
  | 'locked'
  | 'cross-filesystem'
  | 'retained-conflict'
  | 'link-failed'
  | 'failed'

export type ClaudeProfileWarning = {
  surface: ClaudeProfileSurface
  code: ClaudeProfileWarningCode
  /** For logs only. */
  detail: string
}

export type ClaudeProfileReport = {
  surfaces: Partial<Record<ClaudeProfileSurface, ClaudeProfileSurfaceOutcome>>
  warnings: ClaudeProfileWarning[]
}

export class ClaudeProfileSurfaceError extends Error {
  readonly code: ClaudeProfileWarningCode

  constructor(code: ClaudeProfileWarningCode, message: string) {
    super(message)
    this.code = code
  }
}

export function createClaudeProfileReport(): ClaudeProfileReport {
  return { surfaces: {}, warnings: [] }
}

export function warnClaudeProfile(
  report: ClaudeProfileReport,
  surface: ClaudeProfileSurface,
  error: unknown
): void {
  report.warnings.push({
    surface,
    code: error instanceof ClaudeProfileSurfaceError ? error.code : 'failed',
    detail: error instanceof Error ? error.message : String(error)
  })
}

/** One surface's failure is reported and never stops the surfaces after it. */
export async function runClaudeProfileSurface(
  report: ClaudeProfileReport,
  surface: ClaudeProfileSurface,
  operation: () => ClaudeProfileSurfaceOutcome | Promise<ClaudeProfileSurfaceOutcome>
): Promise<void> {
  try {
    report.surfaces[surface] = await operation()
  } catch (error) {
    report.surfaces[surface] = 'failed'
    warnClaudeProfile(report, surface, error)
  }
}
