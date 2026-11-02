import { BlockList, isIP } from 'node:net'
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import { isEligibleLocalCertificateHost } from '../../shared/browser-url'

export type BrowserNetworkTunnelProxy =
  | { kind: 'direct' }
  | { kind: 'http'; url: URL }
  | { kind: 'socks5'; url: URL }
  | { kind: 'unsupported'; protocol: string }

/**
 * The upstream proxy a tunneled connection must use: Orca's proxy setting first, then the
 * environment's HTTPS/ALL/HTTP_PROXY, each with its own bypass list — the precedence the
 * host's own browser sessions apply (proxy-settings.ts).
 */
export function selectBrowserNetworkTunnelProxy(
  target: BrowserNetworkTunnelOpen,
  settings: NetworkProxySettings | null,
  env: Record<string, string | undefined>
): BrowserNetworkTunnelProxy {
  const configured = normalizeProxyUrl(settings?.httpProxyUrl)
  const fromSettings = configured.ok && configured.value !== ''
  const proxyUrl = fromSettings ? configured.value : getProxyUrlFromEnvironment(env).value
  if (!proxyUrl) {
    return { kind: 'direct' }
  }
  const bypassRules = fromSettings
    ? normalizeProxyBypassRules(settings?.httpProxyBypassRules)
    : getProxyBypassRulesFromEnvironment(env)
  if (
    // Why: Chromium never proxies loopback, and the host's own browser sessions follow it.
    isEligibleLocalCertificateHost(target.host) ||
    isLoopbackAddress(target.host) ||
    matchesProxyBypassRules(target, bypassRules, fromSettings ? 'chromium' : 'no-proxy')
  ) {
    return { kind: 'direct' }
  }
  const url = new URL(proxyUrl)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'http', url }
  }
  if (url.protocol === 'socks:' || url.protocol === 'socks5:') {
    return { kind: 'socks5', url }
  }
  return { kind: 'unsupported', protocol: url.protocol }
}

// Why a BlockList: the SOCKS front end hands over IPv6 expanded (`0:0:0:0:0:0:0:1`), not as `::1`.
const LOOPBACK_ADDRESSES = new BlockList()
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6')
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

function isLoopbackAddress(host: string): boolean {
  const address = normalizeHost(host)
  const family = isIP(address)
  return family !== 0 && LOOPBACK_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase()
  return stripTrailingDot(lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower)
}

/**
 * Bypass rules: `*`, `<local>`, `.suffix`/`*suffix`, `host:port`, IPv4 CIDR. A bare host is exact
 * in Orca's setting (Chromium reads it so) and covers subdomains in NO_PROXY (curl/Go/Python).
 */
export function matchesProxyBypassRules(
  target: Pick<BrowserNetworkTunnelOpen, 'host' | 'port'>,
  rules: string,
  style: 'chromium' | 'no-proxy'
): boolean {
  const host = normalizeHost(target.host)
  return rules
    .split(';')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => matchesBypassRule(host, target.port, rule, style))
}

const SCHEME_PORTS: Record<string, string> = { http: '80', ws: '80', https: '443', wss: '443' }

function matchesBypassRule(
  host: string,
  port: number,
  rule: string,
  style: 'chromium' | 'no-proxy'
): boolean {
  if (rule === '*') {
    return true
  }
  if (rule === '<local>') {
    return !host.includes('.') && !host.includes(':')
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(rule)?.[1]
  const withoutScheme = scheme ? rule.slice(scheme.length + 3) : rule
  const cidr = /^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/.exec(withoutScheme)
  if (cidr) {
    return matchesCidr(host, cidr[1]!, Number(cidr[2]))
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(withoutScheme)
  const hostPort = bracketed ? null : /^([^:]+):(\d+)$/.exec(withoutScheme)
  const ruleHost = bracketed?.[1] ?? hostPort?.[1] ?? withoutScheme
  // Why the scheme's port: a tunnel carries host:port only, so `https://x` can match only :443.
  const rulePort = bracketed?.[2] ?? hostPort?.[2] ?? (scheme ? SCHEME_PORTS[scheme] : undefined)
  if (scheme && rulePort === undefined) {
    return false
  }
  if (rulePort !== undefined && Number(rulePort) !== port) {
    return false
  }
  const pattern = stripTrailingDot(ruleHost.startsWith('.') ? `*${ruleHost}` : ruleHost)
  if (pattern.includes('*')) {
    // NO_PROXY also reads `.corp` and `*.corp` as the domain itself; Chromium does not.
    return (
      matchesHostGlob(host, pattern) ||
      (style === 'no-proxy' && pattern.startsWith('*.') && host === pattern.slice(2))
    )
  }
  return style === 'chromium' ? host === pattern : host === pattern || host.endsWith(`.${pattern}`)
}

function matchesHostGlob(host: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(host)
}

function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host
}

function matchesCidr(host: string, network: string, prefix: number): boolean {
  const family = isIP(network)
  if (family === 0 || isIP(host) !== family || prefix > (family === 4 ? 32 : 128)) {
    return false
  }
  const type = family === 4 ? 'ipv4' : 'ipv6'
  const range = new BlockList()
  range.addSubnet(network, prefix, type)
  return range.check(host, type)
}
