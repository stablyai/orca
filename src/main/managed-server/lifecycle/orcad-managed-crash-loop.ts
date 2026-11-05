// Stop waking a managed orcad that keeps dying; an explicit Connect re-arms automatic starts.
import { OrcadUnexpectedExitSchema } from '../../../shared/orcad-unexpected-exit'
import type { OrcadHealth } from '../../orcad/orcad-health'
import { ManagedOrcadEventWindow } from './orcad-managed-event-window'

export const MAX_UNEXPECTED_EXITS_PER_WINDOW = 3
export const UNEXPECTED_EXIT_WINDOW_MS = 10 * 60_000

/** Counts only exits the restarted orcad itself proved unclean on the same boot; holds until reconnect. */
export class ManagedOrcadCrashLoopBrake {
  private readonly exits: ManagedOrcadEventWindow
  /** Engaged hosts, with the reason once read from the host. */
  private readonly engagedHosts = new Map<string, string | null>()

  constructor(now: () => number = Date.now) {
    this.exits = new ManagedOrcadEventWindow(UNEXPECTED_EXIT_WINDOW_MS, now)
  }

  /** Older orcad builds omit the report, so they are never braked. */
  noteStarted(environmentId: string, health: OrcadHealth | undefined): void {
    if (!OrcadUnexpectedExitSchema.safeParse(health?.previousUnexpectedExit).success) {
      return
    }
    this.exits.record(environmentId)
    if (this.exits.recent(environmentId).length >= MAX_UNEXPECTED_EXITS_PER_WINDOW) {
      this.engagedHosts.set(environmentId, this.engagedHosts.get(environmentId) ?? null)
    }
  }

  engaged(environmentId: string): boolean {
    return this.engagedHosts.has(environmentId)
  }

  detail(environmentId: string): string | null {
    return this.engagedHosts.get(environmentId) ?? null
  }

  setDetail(environmentId: string, detail: string): void {
    if (this.engaged(environmentId)) {
      this.engagedHosts.set(environmentId, detail)
    }
  }

  forget(environmentId: string): void {
    this.exits.forget(environmentId)
    this.engagedHosts.delete(environmentId)
  }
}

export function crashLoopMessage(hostLabel: string, logPath: string): string {
  return (
    `Orca stopped restarting its server on ${hostLabel}: it exited unexpectedly ` +
    `${MAX_UNEXPECTED_EXITS_PER_WINDOW} times in ${UNEXPECTED_EXIT_WINDOW_MS / 60_000} minutes. ` +
    `Check ${logPath} on the host, fix the cause, then reconnect the host to try again.`
  )
}

const brake = new ManagedOrcadCrashLoopBrake()

export function getManagedOrcadCrashLoopBrake(): ManagedOrcadCrashLoopBrake {
  return brake
}
