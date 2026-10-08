import { jsonLines, type isolatedScanRoots } from './session-scanner-test-fixtures'

// Shared by the two halves of the every-agent vault, which are split only
// because one file of every agent's layout is past the line ceiling.

export type AgentVaultRoots = ReturnType<typeof isolatedScanRoots>

/** Records as a file body: newline-terminated, the way an agent writes them. */
export function jsonlBody(records: unknown[]): string {
  return `${jsonLines(records)}\n`
}
