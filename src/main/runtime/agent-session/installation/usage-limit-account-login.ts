import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  claudeStateFileAsync,
  readClaudeFolderLoginAsync
} from '../../../claude-accounts/sign-in/claude-account-folder'
import { readCodexAuthIdentity } from '../../../codex-accounts/credentials/codex-auth-identity'

/** Who is signed in to a Claude or Codex folder now, as one comparable string; null when unknown.
 *  Async and cached by file revision: the usage-limit sweep asks once per folder per pass. */
export function createUsageLimitAccountLogin(): (
  provider: string,
  path: string
) => Promise<string | null> {
  const codexLogins = new Map<string, { mtimeMs: number; size: number; login: string | null }>()
  const codexLogin = async (path: string): Promise<string | null> => {
    const file = join(path, 'auth.json')
    const current = await stat(file).catch(() => null)
    if (!current) {
      codexLogins.delete(file)
      return null
    }
    const cached = codexLogins.get(file)
    if (cached?.mtimeMs === current.mtimeMs && cached.size === current.size) {
      return cached.login
    }
    const identity = readCodexAuthIdentity(await readFile(file, 'utf-8'))
    const id = identity?.providerAccountId ?? identity?.email
    const login = id ? JSON.stringify([id, identity?.workspaceAccountId ?? null]) : null
    codexLogins.set(file, { mtimeMs: current.mtimeMs, size: current.size, login })
    return login
  }
  return async (provider, path) => {
    if (provider === 'codex') {
      return codexLogin(path)
    }
    if (provider !== 'claude') {
      return null
    }
    // The default folder keeps its login beside it (~/.claude.json), as Claude itself reads it.
    const isDefault =
      normalizeRuntimePathForComparison(path) ===
      normalizeRuntimePathForComparison(join(homedir(), '.claude'))
    const login = await readClaudeFolderLoginAsync(
      await claudeStateFileAsync(isDefault ? undefined : path)
    )
    return login ? JSON.stringify([login.email.toLowerCase(), login.organizationUuid]) : null
  }
}
