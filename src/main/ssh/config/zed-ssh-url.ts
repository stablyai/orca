import { posix } from 'node:path'
import type { SshTarget } from '../../../shared/ssh-types'
import { isOpenSshConfigBackedTarget } from '../system-transport/system-ssh-args'
import { isValidAuthorityPart } from './vscode-ssh-authority'

type ZedSshUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'ssh-target-invalid' | 'remote-editor-unsupported' }
  | { ok: false; reason: 'ssh-alias-required'; host: string; port: number }

// A leading '-' would reach ssh as an option.
const URL_SAFE_HOST = /^[a-z0-9._~][a-z0-9._~-]*$/i
const IPV6_HOST = /^[0-9a-f:.]+$/i

function formatUrlHost(host: string): string | null {
  if (URL_SAFE_HOST.test(host)) {
    return host
  }
  // Zed passes the URL host to ssh undecoded, so only literal-safe hosts survive the round trip.
  return host.includes(':') && IPV6_HOST.test(host) ? `[${host}]` : null
}

/** Builds `ssh://[user@]host[:port]/path`; Zed connects through the local ssh and its config. */
export function resolveZedSshUrl(target: SshTarget, remotePath: string): ZedSshUrlResult {
  if (!posix.isAbsolute(remotePath)) {
    return { ok: false, reason: 'remote-editor-unsupported' }
  }
  const configBacked = isOpenSshConfigBackedTarget(target)
  const rawHost = configBacked ? (target.configHost ?? '') : target.host
  if (
    !isValidAuthorityPart(rawHost) ||
    (!configBacked &&
      (!isValidAuthorityPart(target.username, true) ||
        !Number.isInteger(target.port) ||
        target.port < 1 ||
        target.port > 65_535))
  ) {
    return { ok: false, reason: 'ssh-target-invalid' }
  }
  const host = formatUrlHost(rawHost.trim())
  if (!host && configBacked) {
    return { ok: false, reason: 'remote-editor-unsupported' }
  }
  // The URL carries only user, host and port; keys, agents and proxies need an alias in ssh config.
  if (!host || (!configBacked && hasSettingsOutsideZedUrl(target))) {
    return { ok: false, reason: 'ssh-alias-required', host: rawHost.trim(), port: target.port }
  }
  const username = configBacked ? '' : target.username.trim()
  const userInfo = username ? `${encodeURIComponent(username)}@` : ''
  // Keep :22 for manual targets so a matching ssh config Port cannot redirect them.
  const port = configBacked ? '' : `:${target.port}`
  const path = remotePath.split('/').map(encodeURIComponent).join('/')
  return { ok: true, url: `ssh://${userInfo}${host}${port}${path}` }
}

function hasSettingsOutsideZedUrl(target: SshTarget): boolean {
  return Boolean(
    target.identityFile ||
    target.identityAgent ||
    target.identitiesOnly ||
    target.gssapiAuthentication ||
    target.jumpHost ||
    target.proxyCommand
  )
}
