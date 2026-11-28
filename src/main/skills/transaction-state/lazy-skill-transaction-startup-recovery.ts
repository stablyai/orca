import { readdir } from 'node:fs/promises'
import type { SkillTransactionStartupRecoveryReport } from './skill-transaction-startup-recovery'

const EMPTY_RECOVERY_REPORT: SkillTransactionStartupRecoveryReport = {
  scanned: 0,
  recovered: 0,
  orphanedExtractionsRecovered: 0,
  orphanedLocksReclaimed: 0,
  failures: [],
  truncated: false
}

export async function recoverPendingSkillTransactionsLazy(
  stateDirectory: string
): Promise<SkillTransactionStartupRecoveryReport> {
  const entries = await readdir(stateDirectory).catch((error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'ENOENT' ? null : ['fallback']
  )
  if (!entries || entries.length === 0) {
    return { ...EMPTY_RECOVERY_REPORT, failures: [] }
  }
  const { recoverPendingSkillTransactions } = await import('./skill-transaction-startup-recovery')
  return recoverPendingSkillTransactions(stateDirectory)
}
