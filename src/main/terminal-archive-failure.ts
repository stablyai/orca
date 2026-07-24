export type TerminalArchiveFailureCode =
  | 'not-owned'
  | 'stale-source'
  | 'capture-unavailable'
  | 'contract-invalid'

/** A bounded failure classification for policy callers; never includes terminal content. */
export class TerminalArchiveError extends Error {
  constructor(readonly code: TerminalArchiveFailureCode) {
    super(code)
    this.name = 'TerminalArchiveError'
  }
}
