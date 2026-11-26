import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudeGlobalConfigFile } from '../../claude/configuration/claude-folder-trust-file'
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import { claudeKeychainService } from '../runtime-auth/keychain'
import type { RotationFolder } from './claude-rotation-login-meta'

export type RotationRouter = {
  accountHome: (accountId: string) => string
  coveredBySystemDefault: (accountId: string) => boolean
  readonly userHome: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** False only when the path is confirmed absent; an unreadable one may be there. */
async function mayExist(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/** An external rotation script (`~/.claude/rotate`) is on, has a swap in flight, or cannot be ruled out. */
export async function externalRotatorActive(userHome: string): Promise<boolean> {
  const dir = join(userHome, '.claude', 'rotate')
  return (await mayExist(join(dir, 'enabled'))) || (await mayExist(join(dir, 'journal.json')))
}

/** The `.claude.json` Claude Code reads for a folder; a legacy `.config.json` wins. */
async function stateFileOf(home: string, userHome: string): Promise<string> {
  const legacy = join(home.normalize('NFC'), '.config.json')
  const hasLegacy = await exists(legacy)
  return resolveClaudeGlobalConfigFile({
    env: { CLAUDE_CONFIG_DIR: home },
    homeDir: userHome,
    style: 'posix',
    exists: (path) => hasLegacy && path === legacy
  })
}

/** Host account folders with their own login; WSL and System default ones are left alone. */
export async function listRotationFolders(
  accounts: ClaudeManagedAccount[],
  router: RotationRouter
): Promise<RotationFolder[]> {
  const folders: RotationFolder[] = []
  for (const account of accounts) {
    if (account.managedAuthRuntime === 'wsl') {
      continue
    }
    try {
      if (router.coveredBySystemDefault(account.id)) {
        continue
      }
      const home = router.accountHome(account.id)
      folders.push({
        accountId: account.id,
        home,
        service: claudeKeychainService(home),
        stateFile: await stateFileOf(home, router.userHome)
      })
    } catch {
      // An unreadable folder cannot take part in a swap.
    }
  }
  return folders
}
