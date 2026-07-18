import { execFile } from 'node:child_process'
import path from 'node:path'
import { isTailnetIPv4Address } from '../../shared/tailnet-address'
import type { TailnetPeerDiscovery, TailnetPeerSuggestion } from '../../shared/tailnet-peers'

const CACHE_TTL_MS = 15 * 1000
const STATUS_TIMEOUT_MS = 3000
const STATUS_MAX_BUFFER_BYTES = 8 * 1024 * 1024

type CacheEntry = {
  expiresAt: number
  discovery: TailnetPeerDiscovery
}

let cache: CacheEntry | null = null
let workingBinary: string | null = null

function tailscaleBinaryCandidates(): string[] {
  // Why: the macOS standalone app and the Windows installer ship the CLI inside
  // their install directory without adding it to PATH, so a bare `tailscale`
  // lookup misses those installs.
  const candidates = ['tailscale']
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  }
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    candidates.push(path.join(programFiles, 'Tailscale', 'tailscale.exe'))
  }
  return candidates
}

function runTailscaleStatus(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['status', '--json'],
      {
        timeout: STATUS_TIMEOUT_MS,
        maxBuffer: STATUS_MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

type RawPeerStatus = {
  HostName?: unknown
  DNSName?: unknown
  OS?: unknown
  TailscaleIPs?: unknown
  Online?: unknown
  sshHostKeys?: unknown
}

function firstTailnetIPv4(ips: unknown): string | null {
  if (!Array.isArray(ips)) {
    return null
  }
  for (const ip of ips) {
    if (typeof ip === 'string' && isTailnetIPv4Address(ip)) {
      return ip
    }
  }
  return null
}

function normalizeDnsName(dnsName: unknown): string {
  return typeof dnsName === 'string' ? dnsName.replace(/\.$/, '') : ''
}

export function parseTailscaleStatusPeers(statusJson: string): TailnetPeerSuggestion[] {
  let status: unknown
  try {
    status = JSON.parse(statusJson)
  } catch {
    return []
  }
  const peerMap =
    typeof status === 'object' && status !== null ? (status as { Peer?: unknown }).Peer : null
  if (typeof peerMap !== 'object' || peerMap === null) {
    return []
  }

  const suggestions: TailnetPeerSuggestion[] = []
  for (const raw of Object.values(peerMap)) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }
    const peer = raw as RawPeerStatus
    const dnsName = normalizeDnsName(peer.DNSName)
    // Why: Mullvad exit nodes are tailnet peers too, but they never accept SSH
    // and would flood the list on tailnets with the exit-node add-on enabled.
    if (dnsName.endsWith('.mullvad.ts.net')) {
      continue
    }
    const ipv4 = firstTailnetIPv4(peer.TailscaleIPs)
    if (!dnsName && !ipv4) {
      continue
    }
    const shortDnsLabel = dnsName.split('.')[0]
    const hostName =
      typeof peer.HostName === 'string' && peer.HostName !== ''
        ? peer.HostName
        : shortDnsLabel || (ipv4 as string)
    suggestions.push({
      hostName,
      dnsName,
      ipv4,
      os: typeof peer.OS === 'string' ? peer.OS : '',
      online: peer.Online === true,
      tailscaleSsh: Array.isArray(peer.sshHostKeys) && peer.sshHostKeys.length > 0
    })
  }

  suggestions.sort(
    (a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName)
  )
  return suggestions
}

export async function discoverTailnetPeers(
  runStatus: (binary: string) => Promise<string> = runTailscaleStatus
): Promise<TailnetPeerDiscovery> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) {
    return cache.discovery
  }

  let discovery: TailnetPeerDiscovery = { available: false, peers: [] }
  const candidates = workingBinary ? [workingBinary] : tailscaleBinaryCandidates()
  for (const binary of candidates) {
    try {
      const output = await runStatus(binary)
      discovery = { available: true, peers: parseTailscaleStatusPeers(output) }
      workingBinary = binary
      break
    } catch {
      // Not installed at this location (or the daemon is down) — a normal,
      // silent outcome; the UI simply shows no suggestions.
    }
  }
  if (!discovery.available) {
    workingBinary = null
  }

  cache = { expiresAt: now + CACHE_TTL_MS, discovery }
  return discovery
}

export function __resetTailnetPeerDiscoveryForTests(): void {
  cache = null
  workingBinary = null
}
