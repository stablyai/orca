import { dirname } from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { translateMain } from '../i18n/main-i18n'
import { logStartupMilestone } from './startup-diagnostics'
import {
  clearGpuFallbackMarker,
  readGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackMarker
} from './gpu-fallback-marker'
import {
  clearInstallDirAclPoisonMarker,
  hasInstallDirAclPoisonMarker,
  writeInstallDirAclPoisonMarker
} from './windows-install-dir-acl-poison-marker'
import {
  buildInstallDirAclRepairCommands,
  isInstallDirAclPoisonVerdict,
  repairWindowsInstallDirPackageAcl,
  type WindowsInstallDirAclRepairArgs,
  type WindowsInstallDirAclRepairResult
} from './windows-install-dir-package-acl-repair'

/** Retain install-DACL diagnosis for renderer recovery instead of mislabeling it as a driver fault. */

export type InstallDirAclPoisonDiagnosis = {
  /** Dialog copy; ends with the commands when the user has to run them. */
  detail: string
  commands: string[]
}

export type WindowsInstallDirAclRecoveryOptions = Omit<WindowsInstallDirAclRepairArgs, 'onDone'>

type RepairStage = WindowsInstallDirAclRepairResult['mode'] | 'pending'

/** Long enough for the ~4-13s repair measured on real hosts, short enough to still be a launch. */
const BLOCKING_REPAIR_BUDGET_MS = 20_000
/** A probe that never answers must not suppress the driver fallback for the session. */
const PROBE_VERDICT_GRACE_MS = 15_000

let poison: { installDir: string; stage: RepairStage } | null = null
let probePendingSince: number | null = null
/** A positive clean DACL reading; outranks any repair verdict about a tree with nothing to fix. */
let installDirReadClean = false
/** A poison DACL reading taken after a repair was dispatched; outranks that repair's success claim. */
let installDirReadPoisonedMidRepair = false
/** What a 'repaired' claim cleared; restored if a later reading disproves the claim. */
let gpuMarkerClearedByRepairClaim: GpuFallbackMarker | null = null
let blockingRepairInFlight = false
const verdictWaiters = new Set<() => void>()

function settleVerdictWaiters(): void {
  // Each wake removes only itself; deleting the visited entry is safe.
  for (const wake of verdictWaiters) {
    wake()
  }
  verdictWaiters.clear()
}

export function resetWindowsInstallDirAclRecoveryForTest(): void {
  poison = null
  probePendingSince = null
  installDirReadClean = false
  installDirReadPoisonedMidRepair = false
  gpuMarkerClearedByRepairClaim = null
  blockingRepairInFlight = false
  settleVerdictWaiters()
}

/** Call when the install-DACL probe is dispatched: its verdict is not in yet. */
export function noteWindowsInstallDirAclProbePending(): void {
  probePendingSince = Date.now()
}

/** Wait for verdict/grace expiry before acting on suspicion the probe may withdraw. */
export function waitForInstallDirAclVerdict(now: number = Date.now()): Promise<void> {
  const remainingMs =
    probePendingSince === null ? 0 : PROBE_VERDICT_GRACE_MS - (now - probePendingSince)
  if (remainingMs <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      verdictWaiters.delete(wake)
      resolve()
    }
    const timer = setTimeout(wake, remainingMs)
    timer.unref?.()
    verdictWaiters.add(wake)
  })
}

/** Suspect DACL can mimic driver death; safe graphics still loses the renderer and hides GPU sibling-death evidence. */
export function isInstallDirAclSuspect(now: number = Date.now()): boolean {
  if (installDirReadClean) {
    return false
  }
  if (poison && poison.stage !== 'repaired') {
    return true
  }
  // Repair success stays provisional until this probe answers or grace expires; child deaths can precede its 0.9-3s reading.
  return probePendingSince !== null && now - probePendingSince < PROBE_VERDICT_GRACE_MS
}

/** Keep safe-graphics markers while repair is pending so a fatal relaunch stops the GPU crash loop and lets the next gate finish. */
export function isInstallDirAclRepairPending(): boolean {
  return poison?.stage === 'pending'
}

/** Spent repair budget leaves diagnosis/admin commands but no future repair to wait for before offering other recovery. */
export function isInstallDirAclRepairExhausted(): boolean {
  return poison?.stage === 'marker-hit'
}

export function isBlockingInstallDirAclRepairInFlight(): boolean {
  return blockingRepairInFlight
}

/** False means the process latch prevented dispatch; no onDone will follow. */
function startRepair(
  installDir: string,
  options: WindowsInstallDirAclRecoveryOptions,
  onDone?: (result: WindowsInstallDirAclRepairResult) => void
): boolean {
  writeInstallDirAclPoisonMarker(options.userDataPath, installDir, options.appVersion)
  const started = repairWindowsInstallDirPackageAcl({
    ...options,
    installDir,
    // Outstanding probe/persisted poison outranks prior success; marker-hit can mean exhausted budget only.
    poisonEvidenceOutstanding: true,
    onDone: (result) => {
      // Post-dispatch poison disproves grant success even if the gate timed out first; subsequent clean evidence retires it.
      const claimDisproved =
        result.mode === 'repaired' && installDirReadPoisonedMidRepair && !installDirReadClean
      // Positive clean evidence outranks any later repair verdict.
      if (!installDirReadClean) {
        poison = { installDir, stage: claimDisproved ? 'failed' : result.mode }
      }
      logStartupMilestone('install-dir-acl-repair-done', { mode: result.mode })
      if (result.mode === 'repaired' && !claimDisproved) {
        clearInstallDirAclPoisonMarker(options.userDataPath)
        // Retire only automatic safe graphics after repair; user-confirmed choice survives.
        const gpuMarker = readGpuFallbackMarker(options.userDataPath)
        if (gpuMarker?.userConfirmed === false) {
          // Retain the cleared marker so later disproof can restore safe launch through the re-armed gate.
          gpuMarkerClearedByRepairClaim = gpuMarker
          clearGpuFallbackMarker(options.userDataPath)
        }
      }
      if (result.mode === 'failed') {
        console.warn('[win32-acl] install dir package ACL repair failed:', result.reason)
      }
      onDone?.(result)
    }
  })
  if (started) {
    poison = { installDir, stage: 'pending' }
  }
  return started
}

/** Apply clean/unknown/poison evidence; only poison dispatches repair. */
export function startWindowsInstallDirAclRepairIfPoisoned(
  data: CrashReportBreadcrumbData,
  options: WindowsInstallDirAclRecoveryOptions
): void {
  // Every verdict ends pending wait; unreadable evidence cannot corroborate provisional repair and grace would release it anyway.
  probePendingSince = null
  try {
    applyInstallDirAclProbeVerdict(data, options)
  } finally {
    // Apply verdict before waking callers that recheck suspicion.
    settleVerdictWaiters()
  }
}

function applyInstallDirAclProbeVerdict(
  data: CrashReportBreadcrumbData,
  options: WindowsInstallDirAclRecoveryOptions
): void {
  if (!isInstallDirAclPoisonVerdict(data)) {
    // Only positive clean evidence retires poison; unreadable DACL proves nothing.
    if (data.matchesPoisonSignature === false) {
      clearInstallDirAclPoisonMarker(options.userDataPath)
      installDirReadClean = true
      // Clean evidence corroborates the repair marker clear.
      gpuMarkerClearedByRepairClaim = null
      // Retain repaired status for reload advice; other stages would keep accusing healthy trees and suppressing driver fallback.
      if (poison?.stage !== 'repaired') {
        poison = null
      }
    }
    return
  }
  // Keep the running gate's ownership; replacing pending loses its callback. Retain the later poison reading to judge its eventual result.
  if (poison?.stage === 'pending') {
    installDirReadPoisonedMidRepair = true
    return
  }
  // Post-gate poison outranks the grant's claimed success.
  if (poison?.stage === 'repaired') {
    poison = { installDir: poison.installDir, stage: 'failed' }
    // Restore safe graphics cleared by the disproved claim or hardware relaunch can abort before the next gate finishes.
    const cleared = gpuMarkerClearedByRepairClaim
    gpuMarkerClearedByRepairClaim = null
    if (cleared) {
      try {
        writeGpuFallbackMarker(options.userDataPath, cleared, cleared)
      } catch {
        // Best effort: the re-armed poison marker below still gates the next launch.
      }
    }
  }
  // Re-arm next-launch poison even when the process latch prevents another grant now.
  startRepair(options.installDir ?? dirname(process.execPath), options)
}

/** Gate known poison before renderer creation: deferred probes take 0.9-3s while renderer init can fail in 48-1373ms. Healthy launches pay only an absent-marker read. */
export async function repairKnownPoisonedInstallDirBeforeWindow(
  options: WindowsInstallDirAclRecoveryOptions & { timeoutMs?: number }
): Promise<'not-marked' | 'skipped' | WindowsInstallDirAclRepairResult['mode'] | 'timeout'> {
  if ((options.platform ?? process.platform) !== 'win32' || options.isServeMode === true) {
    return 'skipped'
  }
  const installDir = options.installDir ?? dirname(process.execPath)
  if (!hasInstallDirAclPoisonMarker(options.userDataPath, installDir, options.appVersion)) {
    return 'not-marked'
  }
  logStartupMilestone('install-dir-acl-repair-blocking-start')
  blockingRepairInFlight = true
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve('timeout'),
        options.timeoutMs ?? BLOCKING_REPAIR_BUDGET_MS
      )
      timer.unref?.()
      // Persisted poison is unretired evidence; old repair success cannot replace this launch's grant.
      const started = startRepair(installDir, options, (result) => {
        clearTimeout(timer)
        resolve(result.mode)
      })
      // No dispatch means no callback; do not wait the full budget.
      if (!started) {
        clearTimeout(timer)
        resolve('skipped')
      }
    })
  } catch (error) {
    // Never throw from this window-creation gate.
    console.warn('[win32-acl] blocking install dir ACL repair faulted:', error)
    return 'skipped'
  } finally {
    blockingRepairInFlight = false
  }
}

// The blank-window recovery dialog is the only place to deliver exact admin commands.
export function describeInstallDirAclPoison(): InstallDirAclPoisonDiagnosis | null {
  if (!poison) {
    return null
  }
  const commands = buildInstallDirAclRepairCommands(poison.installDir)
  const cause = translateMain(
    'installDirAcl.cause',
    "Windows permissions on Orca's install folder are blocking its own sandboxed processes from reading the files it shipped with."
  )
  if (poison.stage === 'repaired') {
    return {
      detail: `${cause}\n\n${translateMain('installDirAcl.repaired', 'Orca repaired the permissions. Reload to use them.')}`,
      commands
    }
  }
  const status =
    poison.stage === 'pending'
      ? translateMain('installDirAcl.repairing', 'Orca is repairing the permissions now.')
      : translateMain(
          'installDirAcl.repairFailed',
          'Orca could not repair them, which usually means the folder needs an administrator.'
        )
  const runCommands = translateMain(
    'installDirAcl.runCommands',
    'Run these in an Administrator Command Prompt, then relaunch Orca:'
  )
  return {
    detail: `${cause} ${status}\n\n${runCommands}\n\n${commands.join('\n')}`,
    commands
  }
}
