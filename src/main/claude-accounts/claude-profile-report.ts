/** A setup step: 'profile', 'hooks', or the name of what it shares (`skills`, `settings.json`). */
export type ClaudeProfileSurface = string

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
