// Stop waking a managed orcad that keeps dying; an explicit Connect re-arms automatic starts.
import { OrcadUnexpectedExitSchema } from '../../../shared/orcad-unexpected-exit'
import type { OrcadHealth } from '../../orcad/orcad-health'
import { OrcadActiveReadinessError } from '../../ssh/orcad-active-readiness'
import { orcadSlotDir } from '../../ssh/orcad-recovery-slot'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { ORCAD_LOG_FILENAME } from '../install/orcad-remote-host-support'
import { withOrcadLogTail } from '../install/orcad-remote-log-tail'
import { ManagedOrcadEventWindow } from './orcad-managed-event-window'
import type { managedOrcadSlot } from './orcad-managed-runtime-context'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'

export const MAX_FAILED_RUNS_PER_WINDOW = 3
export const FAILED_RUN_WINDOW_MS = 10 * 60_000

/** Counts starts that failed and runs the next orcad proved ended uncleanly; holds until reconnect. */
export class ManagedOrcadCrashLoopBrake {
  private readonly failures: ManagedOrcadEventWindow
  /** Engaged hosts, with the reason once read from the host. */
  private readonly engagedHosts = new Map<string, string | null>()
  /** A failed start already counted; the next orcad's report of it must not count twice. */
  private readonly countedFailedStarts = new Set<string>()

  constructor(now: () => number = Date.now) {
    this.failures = new ManagedOrcadEventWindow(FAILED_RUN_WINDOW_MS, now)
  }

  /** Older orcad builds omit the report, so they are never braked. */
  noteStarted(environmentId: string, health: OrcadHealth | undefined): void {
    const alreadyCounted = this.countedFailedStarts.delete(environmentId)
    if (
      !alreadyCounted &&
      OrcadUnexpectedExitSchema.safeParse(health?.previousUnexpectedExit).success
    ) {
      this.record(environmentId)
    }
  }

  noteFailedStart(environmentId: string): void {
    this.countedFailedStarts.add(environmentId)
    this.record(environmentId)
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
    this.failures.forget(environmentId)
    this.engagedHosts.delete(environmentId)
    this.countedFailedStarts.delete(environmentId)
  }

  private record(environmentId: string): void {
    this.failures.record(environmentId)
    if (this.failures.recent(environmentId).length >= MAX_FAILED_RUNS_PER_WINDOW) {
      this.engagedHosts.set(environmentId, this.detail(environmentId))
    }
  }
}

const brake = new ManagedOrcadCrashLoopBrake()

export function getManagedOrcadCrashLoopBrake(): ManagedOrcadCrashLoopBrake {
  return brake
}

type ManagedOrcadSlot = ReturnType<typeof managedOrcadSlot>

type BrakedWake =
  | Awaited<ReturnType<typeof wakeStoppedManagedOrcad>>
  | { outcome: 'crash-loop'; detail: string }

const wakes = new Map<string, Promise<unknown>>()

/** Every automatic wake of a managed orcad goes through here so the brake sees each start. */
export function wakeManagedOrcadUnlessCrashLooping(
  environmentId: string,
  hostLabel: string,
  slot: ManagedOrcadSlot,
  onStarting?: () => void
): Promise<BrakedWake> {
  // Queued wakes must see the failure an earlier wake just recorded.
  const prior = wakes.get(environmentId)
  const wake = (async () => {
    await prior?.catch(() => {})
    return wakeUnlessEngaged(environmentId, hostLabel, slot, onStarting)
  })()
  wakes.set(environmentId, wake)
  void wake
    .catch(() => {})
    .finally(() => {
      if (wakes.get(environmentId) === wake) {
        wakes.delete(environmentId)
      }
    })
  return wake
}

async function wakeUnlessEngaged(
  environmentId: string,
  hostLabel: string,
  slot: ManagedOrcadSlot,
  onStarting?: () => void
): Promise<BrakedWake> {
  if (brake.engaged(environmentId)) {
    return { outcome: 'crash-loop', detail: await crashLoopDetail(environmentId, hostLabel, slot) }
  }
  try {
    const wake = await wakeStoppedManagedOrcad(slot, onStarting)
    if (wake.outcome === 'started') {
      brake.noteStarted(environmentId, wake.readiness.health)
    }
    return wake
  } catch (error) {
    // A launch that never became ready also ends a run.
    if (error instanceof OrcadActiveReadinessError) {
      brake.noteFailedStart(environmentId)
    }
    throw error
  }
}

async function crashLoopDetail(
  environmentId: string,
  hostLabel: string,
  slot: ManagedOrcadSlot
): Promise<string> {
  const known = brake.detail(environmentId)
  if (known) {
    return known
  }
  let detail = crashLoopMessage(hostLabel, `the active server's ${ORCAD_LOG_FILENAME}`)
  try {
    const active = (await readOrcadActivationRecord(slot)).active
    if (active) {
      const slotDir = orcadSlotDir(slot, active)
      const message = crashLoopMessage(
        hostLabel,
        joinRemotePath(slot.host, slotDir, ORCAD_LOG_FILENAME)
      )
      // The log is appended across launches, so its tail still holds the last run's error.
      detail = await withOrcadLogTail(slot, slotDir, message)
    }
  } catch (error) {
    console.warn(`[ssh] Could not read the managed Orca server's log on ${hostLabel}:`, error)
  }
  console.warn(`[ssh] ${detail.split('\n')[0]}`)
  brake.setDetail(environmentId, detail)
  return detail
}

function crashLoopMessage(hostLabel: string, logPath: string): string {
  return (
    `Orca stopped restarting its server on ${hostLabel}: it failed or exited unexpectedly ` +
    `${MAX_FAILED_RUNS_PER_WINDOW} times in ${FAILED_RUN_WINDOW_MS / 60_000} minutes. ` +
    `Check ${logPath} on the host, fix the cause, then disconnect and reconnect the host to try again.`
  )
}
