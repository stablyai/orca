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

const NETWORK_LOOKUP_FAILURE_RE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ESERVFAIL|ERR_NAME_NOT_RESOLVED)\b|lookup address|nodename nor servname|name resolution|dns|websocket|connection refused/i

function globalDnsSection(scutilOutput: string): string {
  const scopedStart = scutilOutput.indexOf('\nDNS configuration (for scoped queries)')
  return scopedStart >= 0 ? scutilOutput.slice(0, scopedStart) : scutilOutput
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

export function withMacTailscaleDnsHintForDiagnostic(
  message: string,
  detail: string | null | undefined,
  diagnostic: DnsDiagnostic | null
): string {
  const probeText = `${message}\n${detail ?? ''}`
  if (!NETWORK_LOOKUP_FAILURE_RE.test(probeText)) {
    return message
  }
  if (!diagnostic) {
    return message
  }

  // Why: Claude/Codex own the failing API transports, so Orca can only point
  // users at the macOS resolver configuration that makes those transports fail.
  return `${message} macOS is using Tailscale MagicDNS (100.100.100.100) as the only global DNS resolver; add an upstream DNS server to the active network service or configure Tailscale global nameservers, then retry.`
}

export function withMacTailscaleDnsHint(message: string, detail?: string | null): string {
  return withMacTailscaleDnsHintForDiagnostic(message, detail, readMacTailscaleDnsDiagnostic())
}

export function __resetMacTailscaleDnsDiagnosticCacheForTests(): void {
  cache = null
}
