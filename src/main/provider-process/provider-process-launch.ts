import { buildConfiguredProxyEnv } from '../../shared/network/network-proxy'
import type { NetworkProxySettings } from '../../shared/network/network-proxy'

export type ProviderProcessLaunch = {
  command: string
  args: string[]
  /** Workspace directory used by the provider process itself. */
  cwd?: string
  /** Overlay on the inherited environment. */
  env?: Record<string, string>
  /** Keys stripped after the overlay. */
  envToDelete?: readonly string[]
}

type ProviderProxySettingsSource = () => NetworkProxySettings | null | undefined

/**
 * Provider sessions are launched from settings-less plumbing, so the configured HTTP proxy
 * reaches them through a module-level source wired once where settings exist. Terminals get
 * the same overlay from the PTY host env assembly; without this, every command a native-chat
 * agent runs egresses on the machine's real IP (#43386).
 */
let providerProxySettingsSource: ProviderProxySettingsSource | null = null

export function setProviderProxySettingsSource(
  source: ProviderProxySettingsSource | null
): void {
  providerProxySettingsSource = source
}

export function resetProviderProxySettingsSourceForTests(): void {
  providerProxySettingsSource = null
}

export function resolveProviderChildEnv(
  launch: Pick<ProviderProcessLaunch, 'env' | 'envToDelete'>,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const proxyEnv = providerProxySettingsSource
    ? buildConfiguredProxyEnv(providerProxySettingsSource())
    : {}
  // The configured proxy beats the inherited environment but not an explicit launch overlay,
  // mirroring how the PTY host env assembly orders the same fields.
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...proxyEnv, ...launch.env }
  for (const key of launch.envToDelete ?? []) {
    delete childEnv[key]
  }
  return childEnv
}
