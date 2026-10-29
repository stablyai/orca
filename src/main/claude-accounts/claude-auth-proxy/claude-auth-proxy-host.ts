import type { ClaudeAuthProxyStatus } from '../../../shared/claude-auth-proxy-status'
import { readClaudeOAuthCredentials } from '../../rate-limits/claude-oauth-credentials'
import { getClaudeProfileRouter } from '../claude-profile-installed-router'
import { setClaudePaneProxySlotReleaser } from '../claude-pane-account-registry'
import { noteUserAnthropicBaseUrl } from './claude-auth-proxy-note'
import { createClaudeAuthProxy, type ClaudeAuthProxy } from './claude-auth-proxy'

export type ClaudeAuthSnapshotIdentity = {
  configDir: string | null
  provenance: string
}

let proxy: ClaudeAuthProxy | null = null
let pending: Promise<void> | null = null
/** Account id → folder, for a host whose profile router is not installed (the WSL guest). */
const accountConfigDirs = new Map<string, string>()

/** Remember which folder a slot's account id reads. The router path ignores this map. */
export function bindClaudeAuthProxyAccountDir(accountId: string, configDir: string): void {
  if (accountId && configDir) {
    accountConfigDirs.set(accountId, configDir)
  }
}

export function claudeAuthProxyListeningPort(): number | null {
  return proxy?.port() ?? null
}

/** Wait out an in-flight start so a spawn does not miss the listener. */
export async function claudeAuthProxyReady(): Promise<ClaudeAuthProxy | null> {
  if (pending) {
    await pending.catch(() => {})
  }
  return proxy
}

/** One loopback listener for this execution host. Safe to call more than once. */
export function startClaudeAuthProxy(): Promise<void> {
  if (proxy) {
    return Promise.resolve()
  }
  if (pending) {
    return pending
  }
  const created = createClaudeAuthProxy({
    readToken: readClaudeAuthProxyAccessToken,
    log: (line) => console.info(`[claude-auth-proxy] ${line}`)
  })
  pending = created
    .start()
    .then(() => {
      proxy = created
      setClaudePaneProxySlotReleaser((slot) => getClaudeAuthProxy()?.releaseSlot(slot))
    })
    .catch((error: unknown) => {
      pending = null
      console.warn('[claude-auth-proxy] failed to start', error)
    })
  return pending
}

export async function stopClaudeAuthProxy(): Promise<void> {
  const starting = pending
  pending = null
  if (starting) {
    await starting.catch(() => {})
  }
  const current = proxy
  proxy = null
  accountConfigDirs.clear()
  setClaudePaneProxySlotReleaser(null)
  if (current) {
    await current.stop()
  }
}

export function getClaudeAuthProxy(): ClaudeAuthProxy | null {
  return proxy
}

export function claudeAuthProxyStatus(): ClaudeAuthProxyStatus {
  return (
    getClaudeAuthProxy()?.status() ?? {
      listening: false,
      host: '127.0.0.1',
      port: null,
      slots: [],
      requestsLastHour: [],
      unknownSlotRequests: 0,
      lastError: null
    }
  )
}

/** `profile:<accountId>` and `profile:<accountId>:wsl:<distro>`. Anything else is unnamed. */
export function claudeAccountIdFromAuthProvenance(provenance: string): string | undefined {
  if (!provenance.startsWith('profile:')) {
    return undefined
  }
  const rest = provenance.slice('profile:'.length)
  const wslAt = rest.indexOf(':wsl:')
  const accountId = wslAt === -1 ? rest : rest.slice(0, wslAt)
  if (accountId.length === 0 || accountId === 'unavailable') {
    return undefined
  }
  return accountId
}

export function invalidateClaudeAuthProxyToken(accountId?: string): void {
  getClaudeAuthProxy()?.invalidateToken(accountId)
}

/**
 * Drops cached bearer tokens when the rate-limit auth snapshot changes.
 * Returns whether a cache drop was requested. An unchanged snapshot keeps the 20s hit.
 */
export function noteClaudeAuthSnapshot(
  previous: ClaudeAuthSnapshotIdentity | null,
  next: ClaudeAuthSnapshotIdentity
): boolean {
  if (
    previous &&
    previous.configDir === next.configDir &&
    previous.provenance === next.provenance
  ) {
    return false
  }
  invalidateClaudeAuthProxyToken(claudeAccountIdFromAuthProvenance(next.provenance))
  return true
}

/**
 * Slot URL for a launch, or undefined when the proxy is off, down, or the user already set a base URL.
 * Each call takes a new slot; the slot in the env that is actually applied is the one that matters.
 */
export function claudeAuthProxyBaseUrl(
  accountId: string | null | undefined,
  env: NodeJS.ProcessEnv,
  enabled: boolean
): string | undefined {
  if (!enabled || !accountId) {
    return undefined
  }
  if (env.ANTHROPIC_BASE_URL) {
    noteUserAnthropicBaseUrl()
    return undefined
  }
  const current = getClaudeAuthProxy()
  if (!current || current.port() === null) {
    return undefined
  }
  return current.slotBaseUrl(current.allocateSlot(accountId)) ?? undefined
}

/** Cache miss path. Never refresh: a refresh would rotate the token into the spawn folder. */
export async function readClaudeAuthProxyAccessToken(accountId: string): Promise<string | null> {
  const router = getClaudeProfileRouter()
  try {
    if (router) {
      const covered = router.coveredBySystemDefault(accountId)
      const userDir = router.userConfigDir()
      const configDir = covered
        ? (userDir ?? router.systemDefaultHome())
        : router.accountHome(accountId)
      const result = await readClaudeOAuthCredentials({
        credentialsFileConfigDir: configDir,
        keychainConfigDir: configDir,
        unsuffixedKeychainFallback: covered && !userDir
      })
      return result.token || null
    }
    const configDir = accountConfigDirs.get(accountId)
    if (!configDir) {
      return null
    }
    const result = await readClaudeOAuthCredentials({
      credentialsFileConfigDir: configDir,
      keychainConfigDir: configDir
    })
    return result.token || null
  } catch {
    return null
  }
}
