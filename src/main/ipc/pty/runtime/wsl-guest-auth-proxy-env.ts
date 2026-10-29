import {
  bindClaudeAuthProxyAccountDir,
  claudeAuthProxyListeningPort,
  claudeAuthProxyReady
} from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-host'
import { isForeignClaudeAuthProxyUrl } from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-url'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth/runtime-auth-types'
import { readClaudeOAuthCredentials } from '../../../rate-limits/claude-oauth-credentials'

type GuestProxy = {
  port: () => number | null
  allocateSlot: (accountId: string) => string
  slotBaseUrl: (slot: string) => string | null
}

export type WslGuestAuthProxyDeps = {
  localPort: () => number | null
  ready: () => Promise<GuestProxy | null>
  readToken: (configDir: string) => Promise<string | null>
  bindDir: (accountId: string, configDir: string) => void
}

async function readGuestConfigDirToken(configDir: string): Promise<string | null> {
  try {
    const result = await readClaudeOAuthCredentials({
      credentialsFileConfigDir: configDir,
      keychainConfigDir: configDir
    })
    return result.token || null
  } catch {
    return null
  }
}

const defaultDeps: WslGuestAuthProxyDeps = {
  localPort: claudeAuthProxyListeningPort,
  ready: claudeAuthProxyReady,
  readToken: readGuestConfigDirToken,
  bindDir: bindClaudeAuthProxyAccountDir
}

/**
 * On the WSL guest, point Claude at this process's loopback slot when the account folder's
 * credential file is readable. A desktop `/p/<slot>/` URL is not a user base URL and is removed.
 * No token means the guest cannot bill through the proxy, so the launch keeps the real API host.
 */
export async function applyWslGuestAuthProxyEnv(
  env: Record<string, string> | undefined,
  enabled: boolean,
  deps: WslGuestAuthProxyDeps = defaultDeps
): Promise<{ env: Record<string, string> | undefined; auth: ClaudeRuntimeAuthPreparation | null }> {
  if (!env) {
    return { env, auth: null }
  }
  const next = { ...env }
  const baseUrl = next.ANTHROPIC_BASE_URL
  if (baseUrl && isForeignClaudeAuthProxyUrl(baseUrl, deps.localPort())) {
    delete next.ANTHROPIC_BASE_URL
  } else if (baseUrl) {
    return { env, auth: null }
  }
  const configDir = next.CLAUDE_CONFIG_DIR
  if (!enabled || !configDir) {
    return { env: next, auth: null }
  }
  const token = await deps.readToken(configDir)
  if (!token) {
    return { env: next, auth: null }
  }
  const proxy = await deps.ready()
  if (!proxy || proxy.port() === null) {
    return { env: next, auth: null }
  }
  deps.bindDir(configDir, configDir)
  const slot = proxy.allocateSlot(configDir)
  const url = proxy.slotBaseUrl(slot)
  if (!url) {
    return { env: next, auth: null }
  }
  next.ANTHROPIC_BASE_URL = url
  return {
    env: next,
    auth: {
      configDir,
      envPatch: { ANTHROPIC_BASE_URL: url, CLAUDE_CONFIG_DIR: configDir },
      provenance: `profile:${configDir}`
    }
  }
}
