import { type Dirent, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  assertOwnedHostCodexManagedHomePath,
  ManagedCodexHomeTemporarilyUnavailableError
} from '../codex-accounts/host-codex-managed-home-ownership'

/** Per-account self-contained host Codex homes present on disk that Orca owns.
 *  Why disk-enumerated, not settings-driven: homes retained after an account
 *  change still hold state, and CLI callers have no settings store. WSL
 *  account homes live inside their distro and are handled by their own lane.
 *  `strict` throws when the root or a home cannot be read, instead of skipping it. */
export function getOwnedCodexAccountHomePaths(options: { strict?: boolean } = {}): string[] {
  const accountsRoot = join(getOrcaUserDataPath(), 'codex-accounts')
  let entries: Dirent[]
  try {
    entries = readdirSync(accountsRoot, { withFileTypes: true })
  } catch (error) {
    if (options.strict && !isDefinitiveAbsence(error)) {
      throw error
    }
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const accountHome = join(accountsRoot, entry.name, 'home')
      try {
        assertOwnedHostCodexManagedHomePath({
          candidatePath: accountHome,
          managedAccountsRoot: accountsRoot,
          systemCodexHomePath: getSystemCodexHomePath(),
          expectedAccountId: entry.name
        })
        return [accountHome]
      } catch (error) {
        if (options.strict && error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
          throw error
        }
        return []
      }
    })
}

/** Session roots of per-account self-contained host Codex homes present on disk. */
export function getCodexAccountHomeSessionDirectories(): string[] {
  return getOwnedCodexAccountHomePaths().flatMap((accountHome) => {
    const sessionsPath = join(accountHome, 'sessions')
    try {
      // Why: a redirected sessions root could make usage scan unrelated, unbounded trees.
      return lstatSync(sessionsPath).isDirectory() ? [sessionsPath] : []
    } catch {
      return []
    }
  })
}
