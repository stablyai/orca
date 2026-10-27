import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { getSecretStore } from '../../shared/secret-store'

/** Report protection gaps and recovery only on change; repeated startup warnings would obscure an unresolved keyring problem. */

type ReportOptions = {
  /** Profile data file; the report state lives beside it. */
  dataFile: string
  log?: (message: string) => void
  /** Escape hatch for support: re-report even if unchanged. */
  force?: boolean
}

type ReportState = { lastReportedGap: string | null }

function stateFile(dataFile: string): string {
  return join(dirname(dataFile), 'orca-secret-protection.json')
}

function readState(path: string): ReportState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && 'lastReportedGap' in parsed) {
      const value = (parsed as ReportState).lastReportedGap
      return { lastReportedGap: typeof value === 'string' ? value : null }
    }
  } catch {
    // Missing or corrupt: treat as never reported and report again.
  }
  return null
}

export function reportSecretProtectionGap(options: ReportOptions): string | null {
  const log = options.log ?? ((message: string) => console.warn(message))
  let gap: string | null
  try {
    gap = getSecretStore().describeProtectionGap()
  } catch (error) {
    // Diagnostics must not preempt the useful error from the first real secret read.
    log(`[secrets] could not determine at-rest protection: ${String(error)}`)
    return null
  }

  const path = stateFile(options.dataFile)
  const previous = readState(path)
  const changed = previous === null || previous.lastReportedGap !== gap

  if (changed || options.force) {
    if (gap) {
      log(`[secrets] ${gap}`)
    } else if (previous?.lastReportedGap) {
      // Silence would leave the previous unprotected warning unresolved.
      log('[secrets] At-rest protection is now provided by the OS keyring.')
    }
  }

  if (changed) {
    try {
      writeFileSync(path, JSON.stringify({ lastReportedGap: gap }), 'utf-8')
    } catch (error) {
      // Re-reporting next launch is preferable to failing startup.
      log(`[secrets] could not persist the protection report state: ${String(error)}`)
    }
  }
  return gap
}
