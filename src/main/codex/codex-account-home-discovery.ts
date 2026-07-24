import { lstatSync, opendirSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import { assertOwnedHostCodexManagedHomePath } from '../codex-accounts/host-codex-managed-home-ownership'

export const CODEX_ACCOUNT_HOME_DISCOVERY_MAX_ENTRIES = 4096
export const CODEX_ACCOUNT_HOME_DISCOVERY_MAX_HOMES = 256
export const CODEX_ACCOUNT_HOME_DISCOVERY_MAX_PATH_CODE_UNITS = 1024 * 1024

export type CodexAccountHomeDiscoveryLimits = {
  maxEntries: number
  maxHomes: number
  maxPathCodeUnits: number
}

/** Session roots of per-account self-contained host Codex homes present on disk.
 *  Why disk-enumerated, not settings-driven: rollouts retained after an account
 *  change must still be counted, and CLI callers have no settings store. WSL
 *  account homes live inside their distro and are scanned by their own lane. */
export function getCodexAccountHomeSessionDirectories(
  limitOverrides: Partial<CodexAccountHomeDiscoveryLimits> = {}
): string[] {
  const limits: CodexAccountHomeDiscoveryLimits = {
    maxEntries: CODEX_ACCOUNT_HOME_DISCOVERY_MAX_ENTRIES,
    maxHomes: CODEX_ACCOUNT_HOME_DISCOVERY_MAX_HOMES,
    maxPathCodeUnits: CODEX_ACCOUNT_HOME_DISCOVERY_MAX_PATH_CODE_UNITS,
    ...limitOverrides
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }

  const accountsRoot = join(getOrcaUserDataPath(), 'codex-accounts')
  try {
    const accountIds: string[] = []
    let entryCount = 0
    let pathCodeUnits = 0
    const directory = opendirSync(accountsRoot)
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        entryCount += 1
        if (entryCount > limits.maxEntries) {
          return failCodexAccountHomeDiscovery('entries', limits.maxEntries)
        }
        pathCodeUnits += entry.name.length
        if (pathCodeUnits > limits.maxPathCodeUnits) {
          return failCodexAccountHomeDiscovery('path code units', limits.maxPathCodeUnits)
        }
        if (entry.isDirectory()) {
          accountIds.push(entry.name)
        }
      }
    } finally {
      closeCodexAccountDirectory(directory)
    }

    const sessionDirectories: string[] = []
    for (const accountId of accountIds.sort()) {
      const accountHome = join(accountsRoot, accountId, 'home')
      const sessionsPath = join(accountHome, 'sessions')
      pathCodeUnits += accountHome.length + sessionsPath.length
      if (pathCodeUnits > limits.maxPathCodeUnits) {
        return failCodexAccountHomeDiscovery('path code units', limits.maxPathCodeUnits)
      }
      try {
        assertOwnedHostCodexManagedHomePath({
          candidatePath: accountHome,
          managedAccountsRoot: accountsRoot,
          systemCodexHomePath: getSystemCodexHomePath(),
          expectedAccountId: accountId
        })
        // Why: a redirected sessions root could make usage scan unrelated, unbounded trees.
        if (lstatSync(sessionsPath).isDirectory()) {
          sessionDirectories.push(sessionsPath)
          if (sessionDirectories.length > limits.maxHomes) {
            return failCodexAccountHomeDiscovery('homes', limits.maxHomes)
          }
        }
      } catch {
        // A missing, redirected, or invalid account home is not a usage source.
      }
    }
    return sessionDirectories
  } catch {
    return []
  }
}

function closeCodexAccountDirectory(directory: ReturnType<typeof opendirSync>): void {
  try {
    directory.closeSync()
  } catch {
    // The OS may have already closed a failed directory stream.
  }
}

function failCodexAccountHomeDiscovery(resource: string, limit: number): [] {
  console.warn(`[codex-usage] Account-home discovery exceeded ${limit} ${resource}; skipping homes`)
  return []
}
