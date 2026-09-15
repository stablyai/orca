/** Address the failed attempt dialed; resolved from `ssh -G` when the target uses an alias. */
export type SshConnectFailureAddress = {
  host: string
  port: number
}

type FailureKind = 'timeout' | 'refused' | 'unreachable' | 'reset' | 'dns'

const FAILURE_CODES: Record<string, FailureKind> = {
  ETIMEDOUT: 'timeout',
  ECONNREFUSED: 'refused',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ECONNRESET: 'reset',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns'
}

// Why prose too: the system OpenSSH transport reports failures as `ssh: connect to host X port
// 22: Operation timed out`, with no errno attached.
const FAILURE_MESSAGE_PATTERNS: [RegExp, FailureKind][] = [
  [/\bETIMEDOUT\b|timed out|timeout/i, 'timeout'],
  [/\bECONNREFUSED\b|connection refused/i, 'refused'],
  [/\bEHOSTUNREACH\b|\bENETUNREACH\b|no route to host|network is unreachable/i, 'unreachable'],
  [/\bECONNRESET\b|connection reset/i, 'reset'],
  [
    /\bENOTFOUND\b|\bEAI_AGAIN\b|could not resolve hostname|nodename nor servname|getaddrinfo|name or service not known/i,
    'dns'
  ]
]

// 100.64.0.0/10 is reserved for carrier-grade NAT; Tailscale hands every node an address in it.
const CGNAT_IPV4_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/
const TAILSCALE_MAGIC_DNS_SUFFIX = '.ts.net'

export function isTailnetAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  return CGNAT_IPV4_RE.test(normalized) || normalized.endsWith(TAILSCALE_MAGIC_DNS_SUFFIX)
}

function classify(error: Error): FailureKind | null {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code && FAILURE_CODES[code]) {
    return FAILURE_CODES[code]
  }
  for (const [pattern, kind] of FAILURE_MESSAGE_PATTERNS) {
    if (pattern.test(error.message)) {
      return kind
    }
  }
  return null
}

function networkPathHint(host: string): string {
  if (isTailnetAddress(host)) {
    return `${host} is a Tailscale address, so check that Tailscale is running and connected on this machine.`
  }
  return `If ${host} is only reachable over a VPN, check that the VPN is connected.`
}

/**
 * The failed attempt as a sentence a user can act on. A raw `connect ETIMEDOUT 100.71.10.60:22`
 * says what the socket saw; this says what is between the two machines. Falls back to the
 * original message for anything it cannot name, so no detail is ever lost.
 */
export function describeSshConnectFailure(error: Error, address: SshConnectFailureAddress): string {
  const kind = classify(error)
  const endpoint = `${address.host}:${address.port}`
  switch (kind) {
    case 'timeout':
      return `${endpoint} did not answer (timed out). The host may be off, asleep, or unreachable from this network. ${networkPathHint(address.host)}`
    case 'unreachable':
      return `No route to ${address.host} from this machine. ${networkPathHint(address.host)}`
    case 'refused':
      return `${endpoint} refused the connection. The host is reachable, but nothing is listening on port ${address.port} — check that sshd is running there.`
    case 'reset':
      return `${endpoint} dropped the connection before the SSH handshake finished.`
    case 'dns':
      return isTailnetAddress(address.host)
        ? `Could not resolve ${address.host}. That is a Tailscale MagicDNS name, so check that Tailscale is running and connected on this machine.`
        : `Could not resolve ${address.host}. Check the hostname and this machine's DNS.`
    case null:
      return error.message
  }
}
