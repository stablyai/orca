import type { SshTarget } from '../../../shared/ssh-types'

/** Random target ids change on re-add; workspace re-adoption and retirement namespaces must share endpoint identity rules. */
export type SshIdentityFields = Pick<SshTarget, 'configHost' | 'host' | 'port' | 'username'>

function normalizeSshIdentityPart(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

/** Manual adds default configHost to host; only a distinct value represents an alias. */
export function meaningfulSshAlias(fields: SshIdentityFields): string {
  const alias = normalizeSshIdentityPart(fields.configHost)
  return alias && alias !== normalizeSshIdentityPart(fields.host) ? alias : ''
}

/** Host/port/user define the endpoint/account for re-adoption and path ownership. */
export function sshEndpointKey(fields: SshIdentityFields): string {
  return `${normalizeSshIdentityPart(fields.host)}|${fields.port}|${normalizeSshIdentityPart(fields.username)}`
}

export type SshRoute = {
  /** The config alias, which `%n` names. */
  alias: string
  host: string
  port: number
  username: string
  proxy?: { kind: 'proxy-command'; command: string } | { kind: 'jump-host'; jumpHost: string }
}

// Expand only the destination tokens; any other token (local host, user, hashes) makes the route unknown.
function expandSshRouteTokens(
  value: string,
  route: SshRoute,
  expander: SshRouteTokenExpander
): string | null {
  const tokens: Record<string, string> = {
    h: route.host.trim(),
    p: String(route.port),
    r: route.username,
    ...(expander === 'openssh' ? { '%': '%', n: route.alias } : {})
  }
  // ssh2's launcher shell-quotes what it inserts, so a token inside quotes means something else there.
  if (expander === 'ssh2' && /(['"])[^'"]*%[hpr][^'"]*\1/.test(value)) {
    return null
  }
  let unknown = false
  const expanded = value.replace(/%(.)/g, (token, name: string) => {
    if (name in tokens) {
      return tokens[name]!
    }
    // ssh2's spawner passes %n and %% through literally.
    if (expander === 'ssh2' && (name === 'n' || name === '%')) {
      return token
    }
    unknown = true
    return ''
  })
  return unknown ? null : expanded.trim()
}

/** OpenSSH expands %h %p %r %n %%; Orca's ssh2 path expands only %h %p %r in a ProxyCommand and nothing in a jump host. */
export type SshRouteTokenExpander = 'openssh' | 'ssh2'

/**
 * Where a target really connects, for import de-duplication: unlike sshEndpointKey it keeps the
 * username's case, because SSH users are case-sensitive, and includes the proxy route. Empty when
 * the route can't be known, so it never matches.
 */
export function sshRouteKey(route: SshRoute, expander: SshRouteTokenExpander = 'openssh'): string {
  const host = normalizeSshIdentityPart(route.host)
  if (!host) {
    return ''
  }
  let proxy = ''
  if (route.proxy) {
    const raw = route.proxy.kind === 'proxy-command' ? route.proxy.command : route.proxy.jumpHost
    const expanded =
      expander === 'ssh2' && route.proxy.kind === 'jump-host'
        ? raw.trim()
        : expandSshRouteTokens(raw, route, expander)
    if (expanded === null) {
      return ''
    }
    proxy = `${route.proxy.kind}:${expanded}`
  }
  return [host, route.port, route.username.trim(), proxy].join('\u0000')
}
