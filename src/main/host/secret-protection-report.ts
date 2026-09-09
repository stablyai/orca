import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { getSecretStore } from '../../shared/secret-store'

/**
 * Report at-rest secret protection, but only when the answer changes.
 *
 * Why this exists: the port has always been able to describe a protection gap, and
 * nothing read it — so a Linux user whose secrets are obfuscated with a built-in key
 * was told nothing at all.
 *
 * Why not every launch: the gap is usually not something the user can fix right now
 * (it needs a keyring installed and unlocked), so repeating it every start is nagging
 * they cannot act on and will learn to ignore. Reporting on change means they hear it
 * when it starts being true, hear it again if it becomes true for a different reason,
 * and are told once when it is fixed.
 *
 * Deliberately not fatal and not a dialog: sealing still works, so blocking startup
 * would be worse than the gap it reports.
 */

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
    // Why swallow: this is diagnostics. An uninstalled store is already a hard failure
    // at the first real read, and that error is the useful one.
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
      // Why announce the recovery: the previous warning said secrets were not protected,
      // so silence would leave the user assuming that is still true.
      log('[secrets] At-rest protection is now provided by the OS keyring.')
    }
  }

  if (changed) {
    try {
      writeFileSync(path, JSON.stringify({ lastReportedGap: gap }), 'utf-8')
    } catch (error) {
      // Best effort: re-reporting next launch is strictly better than failing startup.
      log(`[secrets] could not persist the protection report state: ${String(error)}`)
    }
  }
  return gap
}
