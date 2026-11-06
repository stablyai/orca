export function createClaudeAuthProxyTokenCache(options: {
  ttlMs: number
  now: () => number
  readToken: (accountId: string) => Promise<string | null>
}): {
  tokenFor: (accountId: string) => Promise<string | null>
  invalidate: (accountId?: string) => void
} {
  const tokenCache = new Map<string, { token: string; at: number }>()

  return {
    async tokenFor(accountId) {
      const at = options.now()
      if (options.ttlMs > 0) {
        const cached = tokenCache.get(accountId)
        if (cached && at - cached.at < options.ttlMs) {
          return cached.token
        }
      }
      let token: string | null = null
      try {
        const read = await options.readToken(accountId)
        token = read && read.length > 0 ? read : null
      } catch {
        token = null
      }
      if (token && options.ttlMs > 0) {
        tokenCache.set(accountId, { token, at })
      } else {
        tokenCache.delete(accountId)
      }
      return token
    },
    invalidate(accountId) {
      if (accountId === undefined) {
        tokenCache.clear()
        return
      }
      tokenCache.delete(accountId)
    }
  }
}
