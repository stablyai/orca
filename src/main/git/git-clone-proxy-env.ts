import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { addWslEnvKeys } from '../wsl-env'

/**
 * Merge the app's configured proxy (http/https/socks/socks4/socks5) into a git
 * clone env so clones honor the same proxy Orca uses for its other network
 * children. Git routes transports through libcurl, which reads the standard
 * ALL_PROXY/HTTP(S)_PROXY (+ NO_PROXY) vars buildConfiguredProxyEnv emits — so a
 * socks5:// URL works without any git-config flags.
 *
 * On win32 the keys are added to WSLENV so a WSL-routed clone actually receives
 * them (env does not cross the wsl.exe boundary otherwise). Returns `env`
 * unchanged when no proxy is configured.
 */
export function gitCloneEnvWithProxy(
  env: NodeJS.ProcessEnv,
  proxySettings: NetworkProxySettings | null | undefined,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const proxyEnv = buildConfiguredProxyEnv(proxySettings)
  const proxyKeys = Object.keys(proxyEnv)
  if (proxyKeys.length === 0) {
    return env
  }
  const next = { ...env, ...proxyEnv }
  if (platform === 'win32') {
    addWslEnvKeys(next, proxyKeys)
  }
  return next
}
