// Guest-side process/identity capability for the resident WSL relay. It reads
// /proc directly, so foreground checks never fork wsl.exe on the Windows host.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

import type { RelayDispatcher } from './dispatcher'
import {
  WSL_RELAY_CAPABILITIES,
  WSL_RELAY_PROCESS_METHODS,
  type WslRelayIdentityRequest,
  type WslRelayIdentityResult
} from '../shared/wsl-hook-relay-contract'
import {
  createWslGuestProcessIndexes,
  resolveWslGuestForegroundProcess
} from '../shared/wsl-guest-foreground-process-resolution'
import type {
  WslGuestProcessInventory,
  WslGuestProcessRow
} from '../shared/wsl-guest-process-inventory-parser'

const SNAPSHOT_TTL_MS = 500

export type WslRelayProcessMetrics = {
  snapshots: number
  rowsScanned: number
  resolutions: number
  rejectedAnchors: number
}

const metrics: WslRelayProcessMetrics = {
  snapshots: 0,
  rowsScanned: 0,
  resolutions: 0,
  rejectedAnchors: 0
}

export function getWslRelayProcessMetrics(): WslRelayProcessMetrics {
  return { ...metrics }
}

export function resetWslRelayProcessMetrics(): void {
  metrics.snapshots = 0
  metrics.rowsScanned = 0
  metrics.resolutions = 0
  metrics.rejectedAnchors = 0
  cachedCapture = null
}

type CachedCapture = { inventory: WslGuestProcessInventory; capturedAt: number }

let cachedCapture: CachedCapture | null = null
let inFlightCapture: Promise<CachedCapture> | null = null

function readBootId(): string {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!/^[A-Fa-f0-9-]{8,128}$/.test(bootId)) {
    throw new Error('boot_id_missing')
  }
  return bootId
}

function readStat(pid: number): { row: Omit<WslGuestProcessRow, 'command' | 'tty'>; tty: string } {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8').trim()
  const close = text.lastIndexOf(')')
  if (close === -1) {
    throw new Error('malformed_stat')
  }
  const fields = text.slice(close + 2).split(/\s+/)
  const state = fields[0] ?? '?'
  const numbers = fields.slice(1).map(Number)
  const ppid = numbers[0]
  const pgid = numbers[1]
  const sid = numbers[2]
  const ttyNr = numbers[3]
  const tpgid = numbers[4]
  const startTimeTicks = numbers[18]
  if (![ppid, pgid, sid, ttyNr, tpgid, startTimeTicks].every(Number.isSafeInteger)) {
    throw new Error('malformed_stat')
  }
  // /proc stat's tty_nr is the controlling terminal, unlike fd/0 which may be
  // redirected or closed by a piped/elevated agent. Linux encodes pts majors as
  // 136; retain fd/0 as a fallback for other terminal types.
  const ttyMajor = (ttyNr >> 8) & 0xfff
  const ttyMinor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00)
  let tty = ttyMajor === 136 && ttyMinor >= 0 ? `/dev/pts/${ttyMinor}` : '?'
  if (tty === '?') {
    try {
      const link = readlinkSync(`/proc/${pid}/fd/0`)
      tty = link.startsWith('/dev/') ? link : '?'
    } catch {
      // A process can close stdin while its /proc row is still visible.
    }
  }
  return {
    tty,
    row: {
      pid,
      ppid,
      sid,
      pgid,
      tpgid,
      stat: state,
      startTimeTicks
    }
  }
}

function readCommand(pid: number): string {
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
    if (command) {
      return command
    }
  } catch {
    // The process may exit between stat and cmdline; use comm where possible.
  }
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return ''
  }
}

function capture(distro: string): CachedCapture {
  metrics.snapshots++
  const bootId = readBootId()
  const rows: WslGuestProcessRow[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    const pid = Number(entry)
    try {
      const stat = readStat(pid)
      if (stat.row.stat === 'Z') {
        continue
      }
      rows.push({ ...stat.row, tty: stat.tty, command: readCommand(pid) })
    } catch {
      // A vanished /proc row is expected during a busy capture; skip it.
    }
  }
  metrics.rowsScanned += rows.length
  return { inventory: { distro, bootId, rows }, capturedAt: Date.now() }
}

async function readCapture(distro: string): Promise<CachedCapture> {
  if (cachedCapture && Date.now() - cachedCapture.capturedAt < SNAPSHOT_TTL_MS) {
    return cachedCapture
  }
  if (!inFlightCapture) {
    inFlightCapture = Promise.resolve()
      .then(() => capture(distro))
      .finally(() => {
        inFlightCapture = null
      })
  }
  const next = await inFlightCapture
  cachedCapture = next
  return next
}

export function registerWslRelayProcessHandlers(
  dispatcher: RelayDispatcher,
  relayDistro: string | null
): void {
  dispatcher.onRequest(
    WSL_RELAY_PROCESS_METHODS.identityRead,
    async (params): Promise<{ capability: string; results: WslRelayIdentityResult[] }> => {
      const request = params as unknown as WslRelayIdentityRequest
      const anchors = Array.isArray(request.anchors) ? request.anchors : []
      const distro = typeof request.distro === 'string' ? request.distro : (relayDistro ?? '')
      if (relayDistro && distro.toLowerCase() !== relayDistro.toLowerCase()) {
        return {
          capability: WSL_RELAY_CAPABILITIES.processIdentity,
          results: anchors.map(() => ({
            status: 'unverifiable' as const,
            reason: 'distro_mismatch',
            capturedAgeMs: 0
          }))
        }
      }
      let snapshot: CachedCapture
      try {
        snapshot = await readCapture(distro)
      } catch {
        return {
          capability: WSL_RELAY_CAPABILITIES.processIdentity,
          results: anchors.map(() => ({
            status: 'unverifiable' as const,
            reason: 'capture_failed',
            capturedAgeMs: 0
          }))
        }
      }
      const indexes = createWslGuestProcessIndexes(snapshot.inventory)
      const results = anchors.map((anchor) => {
        metrics.resolutions++
        const resolution = resolveWslGuestForegroundProcess(snapshot.inventory, anchor, indexes)
        if (resolution.status === 'live') {
          return {
            status: 'live' as const,
            processName: resolution.processName,
            anchor: resolution.anchor,
            capturedAgeMs: Math.max(0, Date.now() - snapshot.capturedAt)
          }
        }
        metrics.rejectedAnchors++
        return {
          status: 'unverifiable' as const,
          reason: resolution.reason,
          capturedAgeMs: Math.max(0, Date.now() - snapshot.capturedAt)
        }
      })
      return { capability: WSL_RELAY_CAPABILITIES.processIdentity, results }
    }
  )
}
