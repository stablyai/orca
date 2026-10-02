import { buildConfiguredProxyEnv } from '../../shared/network-proxy'
import type { SshTarget } from '../../shared/ssh-types'

/**
 * Per-spawn proxy env resolver for an SSH target. Re-reads the target on every call so
 * a proxy settings edit reaches the next terminal without reconnecting the host.
 */
export function createSshTargetProxyEnvResolver(
  getTarget: () => SshTarget | null | undefined
): () => Record<string, string> {
  return () => buildConfiguredProxyEnv(getTarget() ?? null)
}
