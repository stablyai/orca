import type { ClaudeSourceCheckpoint } from './journal-claude-import-source-version'

/** A bounded import could not verify or prepare history. The same source can be retried. */
export class ClaudeImportResourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClaudeImportResourceError'
  }
}

export type ClaudeImportGrowth = { prefix: ClaudeSourceCheckpoint; minimumSize: bigint }

export class ClaudeImportGrowthError extends ClaudeImportResourceError {
  constructor(readonly growth: ClaudeImportGrowth) {
    super('Claude transcript grew during history import.')
    this.name = 'ClaudeImportGrowthError'
  }
}
