import { normalizeClaudeConfigDir } from '../rate-limits/service/service-types'

/** Both live posts and transcripts use the execution host's path comparison rules. */
export function claudeAccountHomeKey(path: string | null | undefined): string | null {
  const normalized = normalizeClaudeConfigDir(path)
  return normalized && process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function resolveClaudeAccountHome(
  configDir: string,
  accounts: readonly { id: string }[],
  accountHome: (id: string) => string
): string | null {
  const key = claudeAccountHomeKey(configDir)
  if (!key) {
    return null
  }
  for (const account of accounts) {
    try {
      if (claudeAccountHomeKey(accountHome(account.id)) === key) {
        return account.id
      }
    } catch {
      // A malformed account id must not dark the live feed.
      continue
    }
  }
  return null
}
