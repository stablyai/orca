import { readFileSync } from 'node:fs'
import { parseLinuxStartTicks, readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'

/**
 * What the daemon reports about itself over the readiness IPC channel.
 *
 * Why `pid` is self-reported rather than read from the launcher's `child.pid`: the immediate
 * child is not guaranteed to be the daemon process. The durable-scope launch path spawns
 * `systemd-run --user --scope` (see daemon-cgroup-scope.ts), so the PID the launcher holds only
 * happens to be the daemon's because systemd-run `execvpe()`s the command in scope mode. Reading
 * it from inside the daemon makes the identity independent of that external detail, matching how
 * `detectOwnCgroupScopeUnit` treats cgroup membership as ground truth.
 */
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
    pid?: unknown
    startedAtMs?: unknown
    linuxStartTicks?: unknown
    bootId?: unknown
  }
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
