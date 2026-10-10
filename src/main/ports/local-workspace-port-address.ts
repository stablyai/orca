import type { RawListeningPort } from './local-workspace-port-scan-state'

export function connectHostForBindHost(host: string): string {
  if (host === '*' || host === '0.0.0.0' || host === '::') {
    return 'localhost'
  }
  return host
}

export function dedupeRawPorts(ports: RawListeningPort[]): RawListeningPort[] {
  const seen = new Set<string>()
  const result: RawListeningPort[] = []
  for (const port of ports) {
    const key = `${connectHostForBindHost(port.host)}:${port.port}:${port.pid ?? 'unknown'}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(port)
  }
  return result
}

export function parseAddressWithPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim().replace(/\s+\(LISTEN\)$/i, '')
  const bracketed = trimmed.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) {
    return { host: bracketed[1], port: Number.parseInt(bracketed[2], 10) }
  }
  const match = trimmed.match(/^(.+):(\d+)$/)
  if (!match) {
    return null
  }
  const port = Number.parseInt(match[2], 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null
  }
  return { host: match[1], port }
}

export function parseProcAddress(hexAddress: string): { host: string; port: number } | null {
  const [addrHex, portHex] = hexAddress.split(':')
  const port = Number.parseInt(portHex, 16)
  if (!Number.isFinite(port) || port === 0) {
    return null
  }
  if (addrHex.length === 8) {
    const bytes = [6, 4, 2, 0].map((index) => Number.parseInt(addrHex.slice(index, index + 2), 16))
    return { host: bytes.join('.'), port }
  }
  if (addrHex.length === 32) {
    if (addrHex === '00000000000000000000000000000000') {
      return { host: '::', port }
    }
    if (addrHex === '00000000000000000000000001000000') {
      return { host: '::1', port }
    }
    return { host: formatIPv6Address(addrHex), port }
  }
  return null
}

function formatIPv6Address(hex: string): string {
  const groups: string[] = []
  for (let i = 0; i < 32; i += 8) {
    const chunk = hex.slice(i, i + 8)
    const reversed = chunk.slice(6, 8) + chunk.slice(4, 6) + chunk.slice(2, 4) + chunk.slice(0, 2)
    groups.push(reversed.slice(0, 4), reversed.slice(4, 8))
  }
  return groups.map((group) => group.replace(/^0+/, '') || '0').join(':')
}
