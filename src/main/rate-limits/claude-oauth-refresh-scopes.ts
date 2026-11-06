/** Claude Code `m0t()` when `PLUGINS_SCOPE_REGISTERED` is set. */
export const CLAUDE_OAUTH_DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'user:plugins'
] as const

export function scopesToSend(oauth: Record<string, unknown>): string[] {
  const stored = readScopes(oauth.scopes)
  const clientId = typeof oauth.clientId === 'string' && oauth.clientId ? oauth.clientId : null
  const subscription =
    typeof oauth.subscriptionType === 'string' && oauth.subscriptionType.length > 0
  if (!clientId && (stored.includes('user:inference') || subscription)) {
    const extra = stored.filter(
      (scope) => scope === 'user:projects:read' || scope === 'user:projects:write'
    )
    return unique([...CLAUDE_OAUTH_DEFAULT_SCOPES, ...extra])
  }
  return stored.length > 0 ? stored : [...CLAUDE_OAUTH_DEFAULT_SCOPES]
}

function readScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(' ').filter(Boolean)
  }
  return []
}

function unique(scopes: readonly string[]): string[] {
  return [...new Set(scopes)]
}
