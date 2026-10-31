// Preserve severed AppImage daemon identity for the notice and guarded restart.
import type { DaemonHostImageInspection } from './daemon-host-image'

export type SeveredDaemonIncarnation = {
  pid: number
  linuxStartTicks: string
  bootId: string
}

/** Counts all running terminals a restart would end, including the local fallback. */
export type SeveredDaemonStatus = SeveredDaemonIncarnation & { liveSessionCount: number | null }

export type SeveredDaemonRestartResult =
  | { status: 'restarted'; killedCount: number }
  /** Refuse a replaced or unverified incarnation without killing it. */
  | { status: 'refused'; reason: 'not-severed' | 'replaced' | 'unverifiable' }

/** Supplied by the desktop daemon provider; hosts without one (orcad) report nothing severed. */
export type SeveredDaemonController = {
  countLiveSessions(): Promise<number | null>
  restart(expected: SeveredDaemonIncarnation): Promise<SeveredDaemonRestartResult>
}

let severedDaemon: SeveredDaemonIncarnation | null = null
let controller: SeveredDaemonController | null = null
const listeners = new Set<() => void>()

export function installSeveredDaemonController(next: SeveredDaemonController): void {
  controller = next
}

export async function readSeveredDaemonStatus(): Promise<SeveredDaemonStatus | null> {
  const severed = severedDaemon
  if (!severed || !controller) {
    return null
  }
  return { ...severed, liveSessionCount: await controller.countLiveSessions() }
}

export async function restartSeveredDaemon(
  expected: SeveredDaemonIncarnation
): Promise<SeveredDaemonRestartResult> {
  const severed = severedDaemon
  if (!severed || !controller) {
    return { status: 'refused', reason: 'not-severed' }
  }
  if (!isSameIncarnation(severed, expected)) {
    return { status: 'refused', reason: 'replaced' }
  }
  return controller.restart(expected)
}

export function isSameIncarnation(
  left: SeveredDaemonIncarnation,
  right: SeveredDaemonIncarnation
): boolean {
  return (
    left.pid === right.pid &&
    left.linuxStartTicks === right.linuxStartTicks &&
    left.bootId === right.bootId
  )
}

export function noteSeveredDaemon(inspection: DaemonHostImageInspection): void {
  if (
    inspection.verdict !== 'severed' ||
    inspection.pid === null ||
    !inspection.linuxStartTicks ||
    !inspection.bootId
  ) {
    return
  }
  severedDaemon = {
    pid: inspection.pid,
    linuxStartTicks: inspection.linuxStartTicks,
    bootId: inspection.bootId
  }
  notify()
}

export function clearSeveredDaemon(): void {
  if (severedDaemon) {
    severedDaemon = null
    notify()
  }
}

export function getSeveredDaemon(): SeveredDaemonIncarnation | null {
  return severedDaemon
}

export function onSeveredDaemonChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}
