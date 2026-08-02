import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import { assertOwnedHostCodexManagedHomePath } from '../codex-accounts/host-codex-managed-home-ownership'

/** Session roots of per-account self-contained host Codex homes present on disk.
 *  Why disk-enumerated, not settings-driven: rollouts retained after an account
 *  change must still be counted, and CLI callers have no settings store. WSL
 *  account homes live inside their distro and are scanned by their own lane. */
export function getCodexAccountHomeSessionDirectories(): string[] {
  const accountsRoot = join(getOrcaUserDataPath(), 'codex-accounts')
  try {
    return readdirSync(accountsRoot, { withFileTypes: true })
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
          const sessionsPath = join(accountHome, 'sessions')
          // Why: a redirected sessions root could make usage scan unrelated, unbounded trees.
          return lstatSync(sessionsPath).isDirectory() ? [sessionsPath] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
