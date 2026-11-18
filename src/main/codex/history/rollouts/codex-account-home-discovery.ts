import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { assertOwnedHostCodexManagedHomePath } from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'

/** The home's `sessions` folder, only when it is a real directory. */
export function codexHomeSessionsDirectory(home: string): string[] {
  const sessionsPath = join(home, 'sessions')
  try {
    // Why: a redirected sessions root could make usage scan unrelated, unbounded trees.
    return lstatSync(sessionsPath).isDirectory() ? [sessionsPath] : []
  } catch {
    return []
  }
}

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
          return codexHomeSessionsDirectory(accountHome)
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
