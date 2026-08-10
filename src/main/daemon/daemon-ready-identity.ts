import { readFileSync } from 'node:fs'
import { parseLinuxStartTicks, readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'

export type DaemonReadyIdentity = {
  startedAtMs: number
  linuxStartTicks?: string
  bootId?: string
}

export async function readCurrentDaemonReadyIdentity(
  startedAtMs: number
): Promise<DaemonReadyIdentity> {
  if (process.platform !== 'linux') {
    return { startedAtMs }
  }
  try {
    const linuxStartTicks = parseLinuxStartTicks(readFileSync('/proc/self/stat', 'utf8'))
    const bootId = await readBootIdentity()
    return linuxStartTicks && bootId ? { startedAtMs, linuxStartTicks, bootId } : { startedAtMs }
  } catch {
    return { startedAtMs }
  }
}

/**
 * Reads another process's incarnation markers.
 *
 * Why: `readCurrentDaemonReadyIdentity` only covers /proc/self, but repairing a PID record
 * means republishing the markers of the daemon that actually owns the endpoint.
 */
export async function readDaemonProcessIncarnation(
  pid: number
): Promise<{ linuxStartTicks: string; bootId: string } | null> {
  if (process.platform !== 'linux') {
    return null
  }
  try {
    const linuxStartTicks = parseLinuxStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    const bootId = await readBootIdentity()
    return linuxStartTicks && bootId ? { linuxStartTicks, bootId } : null
  } catch {
    return null
  }
}

export function parseDaemonReadyIdentity(message: unknown): DaemonReadyIdentity | null {
  if (!message || typeof message !== 'object') {
    return null
  }
  const value = message as {
    startedAtMs?: unknown
    linuxStartTicks?: unknown
    bootId?: unknown
  }
  if (
    typeof value.startedAtMs !== 'number' ||
    !Number.isFinite(value.startedAtMs) ||
    value.startedAtMs <= 0
  ) {
    return null
  }
  const hasLinuxStartTicks = value.linuxStartTicks !== undefined
  const hasBootId = value.bootId !== undefined
  if (hasLinuxStartTicks !== hasBootId) {
    return null
  }
  if (!hasLinuxStartTicks) {
    return { startedAtMs: value.startedAtMs }
  }
  if (
    typeof value.linuxStartTicks !== 'string' ||
    value.linuxStartTicks.length === 0 ||
    typeof value.bootId !== 'string' ||
    value.bootId.length === 0
  ) {
    return null
  }
  return {
    startedAtMs: value.startedAtMs,
    linuxStartTicks: value.linuxStartTicks,
    bootId: value.bootId
  }
}
