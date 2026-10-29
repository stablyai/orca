import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import { assertOwnedHostCodexManagedHomePath } from '../codex-accounts/host-codex-managed-home-ownership'

// Enumerate disk to include retired accounts without a settings store; WSL scans its own homes.
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
