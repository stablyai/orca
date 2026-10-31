import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

export type UsageAccountRoot = { path: string; accountId: string }

type AccountClaims = {
  keys: readonly string[]
  accountIds?: readonly (string | null)[]
}

/** Root identity is evidence only for exclusive storage, never for linked/shared history. */
export function createUsageAccountRootResolver(roots: readonly UsageAccountRoot[]) {
  const canonicalRoots = new Map<string, Promise<string | null>>()
  const canonicalRoot = (path: string): Promise<string | null> => {
    const retained = canonicalRoots.get(path)
    if (retained) {
      return retained
    }
    const pending = Promise.all([lstat(path), realpath(path)])
      .then(([info, canonical]) => (info.isDirectory() ? canonical : null))
      .catch(() => null)
    canonicalRoots.set(path, pending)
    return pending
  }
  return async (filePath: string): Promise<string | null> => {
    const matching = roots.filter((root) => {
      const suffix = relative(root.path, filePath)
      return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
    })
    if (matching.length !== 1) {
      return null
    }
    try {
      const root = await canonicalRoot(matching[0].path)
      if (root === null) {
        return null
      }
      const suffix = relative(root, await realpath(filePath))
      if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
        return null
      }
      const info = await lstat(filePath)
      return info.isFile() && info.nlink === 1 ? matching[0].accountId : null
    } catch {
      return null
    }
  }
}

export function createUsageAccountAttribution(previous: readonly AccountClaims[]) {
  const accounts = new Map<string, string | null>()
  const observe = (key: string, accountId: string | null): string | null => {
    if (!accounts.has(key)) {
      accounts.set(key, accountId)
    } else if (accounts.get(key) !== accountId) {
      accounts.set(key, null)
    }
    return accounts.get(key) ?? null
  }
  for (const source of previous) {
    source.keys.forEach((key, index) => observe(key, source.accountIds?.[index] ?? null))
  }
  return {
    observe,
    needsReprojection: (source: AccountClaims) =>
      source.keys.some(
        (key, index) => (source.accountIds?.[index] ?? null) !== (accounts.get(key) ?? null)
      )
  }
}
