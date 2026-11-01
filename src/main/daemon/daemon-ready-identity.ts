import { readFileSync } from 'node:fs'
import { parseLinuxStartTicks, readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'

/** Self-reported identity avoids relying on launcher PIDs that may belong to wrappers. */
export type DaemonReadyIdentity = {
  pid: number
  startedAtMs: number
  linuxStartTicks?: string
  bootId?: string
}

export async function readCurrentDaemonReadyIdentity(
  startedAtMs: number
): Promise<DaemonReadyIdentity> {
  const identity = { pid: process.pid, startedAtMs }
  if (process.platform !== 'linux') {
    return identity
  }
  try {
    const linuxStartTicks = parseLinuxStartTicks(readFileSync('/proc/self/stat', 'utf8'))
    const bootId = await readBootIdentity()
    return linuxStartTicks && bootId ? { ...identity, linuxStartTicks, bootId } : identity
  } catch {
    return identity
  }
}

/** PID-record repair needs the endpoint owner's incarnation, not this process's. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseDaemonReadyIdentity(message: unknown): DaemonReadyIdentity | null {
  if (!isRecord(message)) {
    return null
  }
  const value: Record<string, unknown> = message
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    return null
  }
  if (
    typeof value.startedAtMs !== 'number' ||
    !Number.isFinite(value.startedAtMs) ||
    value.startedAtMs <= 0
  ) {
    return null
  }
  const identity = { pid: value.pid, startedAtMs: value.startedAtMs }
  const hasLinuxStartTicks = value.linuxStartTicks !== undefined
  const hasBootId = value.bootId !== undefined
  if (hasLinuxStartTicks !== hasBootId) {
    return null
  }
  if (!hasLinuxStartTicks) {
    return identity
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
    ...identity,
    linuxStartTicks: value.linuxStartTicks,
    bootId: value.bootId
  }
}
