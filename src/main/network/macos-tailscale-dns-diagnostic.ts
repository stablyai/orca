import { execFileSync } from 'node:child_process'

const TAILSCALE_MAGIC_DNS = '100.100.100.100'
const CACHE_TTL_MS = 5 * 60 * 1000

type DnsDiagnostic = {
  globalNameservers: string[]
}

type CacheEntry = {
  expiresAt: number
  diagnostic: DnsDiagnostic | null
}

let cache: CacheEntry | null = null

// Prefer locale-independent error codes; broad candidates only reread cached state, while misses hide useful hints.
const NETWORK_LOOKUP_FAILURE_RE =
  /\b(?:ENOTFOUND|ENODATA|EAI_AGAIN|EAI_FAIL|EAI_NODATA|EAI_NONAME|ESERVFAIL|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|getaddrinfo)\b|lookup address|nodename nor servname|name resolution|name or service not known|no address associated with hostname|(?:could not|couldn't|cannot|can't|unable to|failed to) resolve|dns|websocket|connection refused/i

const MAGIC_DNS_HINT =
  'macOS is using Tailscale MagicDNS (100.100.100.100) as the only global DNS resolver; add an upstream DNS server to the active network service or configure Tailscale global nameservers, then retry.'

/** Probe admission and hint display must share eligibility so genuine DNS failures retain diagnostics. */
export function isMacTailscaleDnsHintCandidate(message: string, detail?: string | null): boolean {
  // Avoid matching the hint’s own DNS text on repeated wrapping.
  if (message.endsWith(MAGIC_DNS_HINT)) {
    return false
  }
  return NETWORK_LOOKUP_FAILURE_RE.test(`${message}\n${detail ?? ''}`)
}

function globalDnsSection(scutilOutput: string): string {
  const scopedStart = scutilOutput.indexOf('\nDNS configuration (for scoped queries)')
  return scopedStart !== -1 ? scutilOutput.slice(0, scopedStart) : scutilOutput
}

export function parseMacTailscaleDnsDiagnostic(scutilOutput: string): DnsDiagnostic | null {
  const globalSection = globalDnsSection(scutilOutput)
  const nameservers = [
    ...new Set(
      Array.from(globalSection.matchAll(/nameserver\[\d+\]\s*:\s*([^\s]+)/g), (match) =>
        match[1].trim()
      )
    )
  ]

  if (nameservers.length === 0) {
    return null
  }
  if (!nameservers.every((nameserver) => nameserver === TAILSCALE_MAGIC_DNS)) {
    return null
  }

  return { globalNameservers: nameservers }
}

function readMacTailscaleDnsDiagnostic(now = Date.now()): DnsDiagnostic | null {
  if (process.platform !== 'darwin') {
    return null
  }
  if (cache && cache.expiresAt > now) {
    return cache.diagnostic
  }

  let diagnostic: DnsDiagnostic | null = null
  try {
    const output = execFileSync('/usr/sbin/scutil', ['--dns'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    diagnostic = parseMacTailscaleDnsDiagnostic(output)
  } catch {
    diagnostic = null
  }

  cache = { diagnostic, expiresAt: now + CACHE_TTL_MS }
  return diagnostic
}

// Provider-owned transports prevent direct repair; explain the macOS resolver state instead.
function appendMagicDnsHint(message: string, diagnostic: DnsDiagnostic | null): string {
  return diagnostic ? `${message} ${MAGIC_DNS_HINT}` : message
}

export function withMacTailscaleDnsHintForDiagnostic(
  message: string,
  detail: string | null | undefined,
  diagnostic: DnsDiagnostic | null
): string {
  return isMacTailscaleDnsHintCandidate(message, detail)
    ? appendMagicDnsHint(message, diagnostic)
    : message
}

export function withMacTailscaleDnsHint(message: string, detail?: string | null): string {
  if (process.platform !== 'darwin') {
    return message
  }
  if (!isMacTailscaleDnsHintCandidate(message, detail)) {
    return message
  }
  return appendMagicDnsHint(message, readMacTailscaleDnsDiagnostic())
}

export function __resetMacTailscaleDnsDiagnosticCacheForTests(): void {
  cache = null
}
