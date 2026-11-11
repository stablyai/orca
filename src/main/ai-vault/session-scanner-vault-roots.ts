import { jsonLines, type isolatedScanRoots } from './session-scanner-test-fixtures'

export type AgentVaultRoots = ReturnType<typeof isolatedScanRoots>

export function jsonlBody(records: unknown[]): string {
  return `${jsonLines(records)}\n`
}
