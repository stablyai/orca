// Stop waking a managed orcad that keeps dying; an explicit Connect re-arms automatic starts.
import { OrcadUnexpectedExitSchema } from '../../../shared/orcad-unexpected-exit'
import type { OrcadHealth } from '../../orcad/orcad-health'
import { OrcadLaunchReadinessError } from '../../ssh/orcad-active-readiness'
import { orcadSlotDir, type OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { ORCAD_LOG_FILENAME } from '../install/orcad-remote-host-support'
import { withOrcadLogTail } from '../install/orcad-remote-log-tail'
import { readBoundedOrcadRemoteRecord } from '../install/orcad-remote-record-file'
import { ORCAD_LOCK_FILE_NAME } from '../../orcad/orcad-instance-lock'
import { MAX_ORCAD_LOCK_BYTES } from '../../orcad/orcad-instance-lock-reclaim'
import { OrcadWindowsLaunchFailedError } from '../install/orcad-remote-launch-windows'
import { ManagedOrcadEventWindow } from './orcad-managed-event-window'
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
  // Wakes begun before an explicit reconnect must not undo its reset.
  private readonly resets = new Map<string, number>()
  private readonly latchedOnServingRun = new Set<string>()
  private readonly lastFailedStart = new Map<string, string>()

  constructor(now: () => number = Date.now) {
    this.failures = new ManagedOrcadEventWindow(FAILED_RUN_WINDOW_MS, now)
  }

  resetEpoch(environmentId: string): number {
    return this.resets.get(environmentId) ?? 0
  }

  /** Older orcad builds omit the report, so they are never braked. */
  noteStarted(environmentId: string, epoch: number, health: OrcadHealth | undefined): void {
    if (epoch !== this.resetEpoch(environmentId)) {
      return
    }
    const alreadyCounted = this.countedFailedStarts.delete(environmentId)
    if (
      !alreadyCounted &&
      OrcadUnexpectedExitSchema.safeParse(health?.previousUnexpectedExit).success
    ) {
      this.record(environmentId)
      if (this.engaged(environmentId)) {
        this.latchedOnServingRun.add(environmentId)
      }
    }
  }

  noteFailedStart(environmentId: string, epoch: number, reason: string): void {
    if (epoch !== this.resetEpoch(environmentId)) {
      return
    }
    this.countedFailedStarts.add(environmentId)
    this.lastFailedStart.set(environmentId, reason)
    this.latchedOnServingRun.delete(environmentId)
    this.record(environmentId)
  }

  /** True when the latch came from a run that served, whose own exit decides whether it still holds. */
  latchedOnServingRunOf(environmentId: string): boolean {
    return this.latchedOnServingRun.has(environmentId)
  }

  lastFailedStartOf(environmentId: string): string | null {
    return this.lastFailedStart.get(environmentId) ?? null
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
    this.latchedOnServingRun.delete(environmentId)
    this.lastFailedStart.delete(environmentId)
    this.resets.set(environmentId, this.resetEpoch(environmentId) + 1)
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

type ManagedOrcadSlot = OrcadSlotOptions

type BrakedWake =
  | Exclude<Awaited<ReturnType<typeof wakeStoppedManagedOrcad>>, { outcome: 'launch-refused' }>
  | { outcome: 'crash-loop'; detail: string }

const wakes = new Map<string, Promise<unknown>>()

/** Every automatic wake of a managed orcad goes through here so the brake sees each start. */
export function wakeManagedOrcadUnlessCrashLooping(
  environmentId: string,
  hostLabel: string,
  slot: ManagedOrcadSlot,
  onStarting?: () => void
): Promise<BrakedWake> {
  // Queued wakes must see the failure an earlier wake just recorded; the epoch is the caller's.
  const epoch = brake.resetEpoch(environmentId)
  const prior = wakes.get(environmentId)
  const wake = (async () => {
    await prior?.catch(() => {})
    return wakeUnlessEngaged(environmentId, epoch, hostLabel, slot, onStarting)
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
  epoch: number,
  hostLabel: string,
  slot: ManagedOrcadSlot,
  onStarting?: () => void
): Promise<BrakedWake> {
  if (brake.engaged(environmentId) && (await latchedRunExitedCleanly(environmentId, slot))) {
    brake.forget(environmentId)
    // This wake starts the fresh budget, so it must count.
    epoch = brake.resetEpoch(environmentId)
  }
  try {
    // The brake refuses only a new launch, at the decision itself; live servers are reported as they are.
    const wake = await wakeStoppedManagedOrcad(
      slot,
      onStarting,
      () => !brake.engaged(environmentId)
    )
    if (wake.outcome === 'launch-refused') {
      return {
        outcome: 'crash-loop',
        detail: await crashLoopDetail(environmentId, hostLabel, slot)
      }
    }
    if (wake.outcome === 'started') {
      brake.noteStarted(environmentId, epoch, wake.readiness.health)
    }
    return wake
  } catch (error) {
    // A launch that never became ready, or that the host reported failing, also ends a run.
    // A host-policy refusal is not: nothing ran, and its own message says what to change.
    if (
      error instanceof OrcadLaunchReadinessError ||
      error instanceof OrcadWindowsLaunchFailedError
    ) {
      brake.noteFailedStart(environmentId, epoch, error.message)
    }
    throw error
  }
}

/** A run that served releases orcad.lock on a clean exit, so an absent lock means the loop ended. */
async function latchedRunExitedCleanly(
  environmentId: string,
  slot: ManagedOrcadSlot
): Promise<boolean> {
  if (!brake.latchedOnServingRunOf(environmentId)) {
    return false
  }
  try {
    const lock = await readBoundedOrcadRemoteRecord(
      slot,
      joinRemotePath(slot.host, slot.userDataDir, ORCAD_LOCK_FILE_NAME),
      MAX_ORCAD_LOCK_BYTES
    )
    return lock.state === 'absent'
  } catch {
    // Unreadable proves nothing; stay braked.
    return false
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
  const lastFailure = brake.lastFailedStartOf(environmentId)
  const withLastFailure = (message: string): string =>
    lastFailure ? `${message}\nLast failed start: ${lastFailure}` : message
  let detail = withLastFailure(
    crashLoopMessage(hostLabel, `the active server's ${ORCAD_LOG_FILENAME}`)
  )
  try {
    const active = (await readOrcadActivationRecord(slot)).active
    if (active) {
      const slotDir = orcadSlotDir(slot, active)
      const message = crashLoopMessage(
        hostLabel,
        joinRemotePath(slot.host, slotDir, ORCAD_LOG_FILENAME)
      )
      // The log is appended across launches, so its tail still holds the last run's error.
      detail = await withOrcadLogTail(slot, slotDir, withLastFailure(message))
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
