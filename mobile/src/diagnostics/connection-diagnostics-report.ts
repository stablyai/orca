import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type {
  ConnectionLogEntry,
  ConnectionState,
  MobileConnectionDiagnosticPath
} from '../transport/types'
import { normalizeHostAppVersion } from '../transport/host-app-version-store'
import { formatEndpoint } from './host-reachability'
import { diagnoseConnection } from './connection-diagnostics-analysis'
import { redactConnectionLogEntry, redactConnectionLogText } from './connection-log-redaction'

const MAX_EVENT_LINE_BYTES = 2 * 1024
const EVENT_TRUNCATION_MARKER = ' … [truncated]'

// Why: one shareable text blob answering everything we historically had to
// ask reporters one message at a time (endpoint type, state, attempt count,
// last-connected, versions, and the reconnect lifecycle log).
export function buildConnectionDiagnosticsReport(args: {
  hostName: string
  endpoint: string
  state: ConnectionState
  reconnectAttempts: number
  lastConnectedAt: number | null
  platform: string
  appVersion: string
  desktopAppVersion?: string | null
  entries: readonly ConnectionLogEntry[]
  activePath?: MobileConnectionDiagnosticPath
  pendingPath?: MobileConnectionDiagnosticPath | null
  nowMs?: number
}): string {
  const now = args.nowMs ?? Date.now()
  const entries = args.entries.map(redactConnectionLogEntry)
  const diagnosis = diagnoseConnection({
    endpoint: args.endpoint,
    state: args.state,
    activePath: args.activePath,
    pendingPath: args.pendingPath,
    entries
  })
  const lines: string[] = []
  lines.push('Orca Mobile connection diagnostics')
  lines.push(`Generated: ${new Date(now).toISOString()}`)
  lines.push(`App: Orca Mobile ${args.appVersion} · ${args.platform}`)
  const desktopAppVersion = normalizeHostAppVersion(args.desktopAppVersion)
  lines.push(`Host Orca version: ${desktopAppVersion ?? 'unknown'}`)
  lines.push(`Host: ${redactConnectionLogText(args.hostName)}`)
  lines.push(
    `Endpoint: ${formatEndpoint(args.endpoint)}${isTailscaleEndpoint(args.endpoint) ? ' (Tailscale)' : ''}`
  )
  lines.push(`State: ${args.state} (reconnect attempts: ${args.reconnectAttempts})`)
  if (args.activePath) {
    lines.push(
      `Path: active=${args.activePath}${args.pendingPath ? `; recovery=${args.pendingPath}` : ''}`
    )
  }
  lines.push(
    args.lastConnectedAt == null
      ? 'Last connected: never this session'
      : `Last connected: ${new Date(args.lastConnectedAt).toISOString()} (${formatAgo(now - args.lastConnectedAt)} ago)`
  )
  lines.push('')
  lines.push(`Likely cause: ${diagnosis.likelyCause}`)
  lines.push(`Next step: ${diagnosis.nextStep}`)
  lines.push('')
  if (entries.length === 0) {
    lines.push('No connection events recorded.')
  } else {
    lines.push(`Recent connection history (${entries.length} events, oldest first):`)
    for (const entry of entries) {
      const detail = entry.detail ? ` — ${entry.detail}` : ''
      const evidence = [entry.code, entry.path].filter(Boolean).join(' · ')
      lines.push(
        truncateUtf8WithMarker(
          `${new Date(entry.ts).toISOString()} [${entry.level}]${evidence ? ` [${evidence}]` : ''} ${entry.message}${detail}`,
          MAX_EVENT_LINE_BYTES,
          EVENT_TRUNCATION_MARKER
        )
      )
    }
  }
  return lines.join('\n')
}

function truncateUtf8WithMarker(value: string, maxBytes: number, marker: string): string {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) {
    return value
  }
  const markerBytes = new TextEncoder().encode(marker).byteLength
  const characters: string[] = []
  let bytes = 0
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength
    if (bytes + characterBytes + markerBytes > maxBytes) {
      break
    }
    characters.push(character)
    bytes += characterBytes
  }
  return `${characters.join('')}${marker}`
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
