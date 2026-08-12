import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import {
  parseServeUpdateHandoffState,
  type ServeUpdateHandoffState
} from '../../shared/serve-update-handoff'
import {
  SERVE_ALREADY_RUNNING_EXIT_CODE,
  SERVE_SUPERVISOR_STOP_EXIT_CODE
} from '../../shared/serve-supervision'
import type { ServeRuntimeHealth } from './serve-runtime-health'
import type { ServeSingletonRecoveryResult } from './serve-singleton-recovery'
import {
  SERVE_HEALTH_CHECK_INTERVAL_MS,
  SERVE_HEALTH_FAILURE_LIMIT,
  waitForForegroundServeChild
} from './serve-child-monitor'
import { serveSignalExitError } from './serve-signal-exit-diagnostic'
import { waitForMacBundleVersion } from './mac-app-update-bundle'

export const SERVE_CRASH_BUDGET_RESET_MS = 5 * 60_000
export const SERVE_CRASH_RESTART_DELAYS_MS = [1_000, 5_000, 15_000] as const
export { SERVE_SUPERVISOR_STOP_EXIT_CODE } from '../../shared/serve-supervision'
export {
  SERVE_HEALTH_CHECK_INTERVAL_MS,
  SERVE_HEALTH_FAILURE_LIMIT,
  SERVE_REPLACEMENT_READY_TIMEOUT_MS
} from './serve-child-monitor'

type InstallRequestedHandoff = Extract<ServeUpdateHandoffState, { phase: 'install-requested' }>

type ServeSupervisorArgs = {
  executable: string
  childArgs: string[]
  spawnOptions: SpawnOptions
  spawnChild: typeof spawn
  handoffPath: string | null
  healthProbe?: () => Promise<ServeRuntimeHealth>
  recoverSingleton?: () => Promise<ServeSingletonRecoveryResult>
  beforeRestart?: () => Promise<void>
  sleep?: (delayMs: number) => Promise<void>
  restartDelaysMs?: readonly number[]
  healthCheckIntervalMs?: number
  healthFailureLimit?: number
  stableRunResetMs?: number
}

export async function resumeInterruptedServeUpdate(
  args: ServeSupervisorArgs & { handoffPath: string; handoff: InstallRequestedHandoff }
): Promise<number> {
  const installed = await waitForMacBundleVersion(args.executable, args.handoff.targetVersion)
  if (!installed) {
    await recordServeUpdateHandoffFailure(
      args.handoffPath,
      args.handoff,
      `Timed out waiting for Orca ${args.handoff.targetVersion} to be installed.`
    )
  }
  const child = args.spawnChild(args.executable, args.childArgs, args.spawnOptions)
  return superviseForegroundServe({
    ...args,
    child,
    expectedHandoff: installed ? args.handoff : null
  })
}

export async function superviseForegroundServe(
  args: ServeSupervisorArgs & {
    child: ChildProcess
    expectedHandoff: InstallRequestedHandoff | null
  }
): Promise<number> {
  let child = args.child
  let expectedHandoff = args.expectedHandoff
  let restartIndex = 0
  let singletonRetryUsed = false
  const restartDelays = args.restartDelaysMs ?? SERVE_CRASH_RESTART_DELAYS_MS
  const sleep = args.sleep ?? defaultSleep

  while (true) {
    const result = await waitForForegroundServeChild(
      child,
      args.handoffPath && expectedHandoff
        ? {
            targetVersion: expectedHandoff.targetVersion,
            recordFailure: (reason) =>
              recordServeUpdateHandoffFailure(args.handoffPath!, expectedHandoff!, reason),
            complete: (runtimeId) =>
              completeServeUpdateHandoff(args.handoffPath!, expectedHandoff!, runtimeId)
          }
        : null,
      {
        healthProbe: args.healthProbe,
        healthCheckIntervalMs: args.healthCheckIntervalMs ?? SERVE_HEALTH_CHECK_INTERVAL_MS,
        healthFailureLimit: args.healthFailureLimit ?? SERVE_HEALTH_FAILURE_LIMIT
      }
    )

    if (expectedHandoff && result.readiness === 'failed') {
      return 1
    }
    if (expectedHandoff && result.readiness !== 'verified') {
      if (args.handoffPath) {
        await recordServeUpdateHandoffFailure(
          args.handoffPath,
          expectedHandoff,
          `Replacement exited before serving version ${expectedHandoff.targetVersion}.`
        )
      }
      return 1
    }

    const handoff = args.handoffPath ? await readServeUpdateHandoff(args.handoffPath) : null
    if (
      handoff?.phase === 'install-requested' &&
      (child.pid === undefined || handoff.servingPid === child.pid)
    ) {
      const installed = await waitForMacBundleVersion(args.executable, handoff.targetVersion)
      if (!installed) {
        await recordServeUpdateHandoffFailure(
          args.handoffPath!,
          handoff,
          `Timed out waiting for Orca ${handoff.targetVersion} to be installed.`
        )
        expectedHandoff = null
      } else {
        expectedHandoff = handoff
      }
      const replacement = await spawnRestartChild(args)
      if (!replacement) {
        return expectedHandoff ? 1 : SERVE_SUPERVISOR_STOP_EXIT_CODE
      }
      child = replacement
      continue
    }

    if (expectedHandoff && result.readiness === 'verified') {
      expectedHandoff = null
    }
    if (result.readiness === 'verified') {
      singletonRetryUsed = false
    }
    if (result.terminationRequested) {
      if (typeof result.code === 'number') {
        return result.code
      }
      throw serveSignalExitError(result.signal)
    }
    if (!args.healthProbe && !args.recoverSingleton) {
      if (typeof result.code === 'number') {
        return result.code
      }
      throw serveSignalExitError(result.signal)
    }
    if (result.code === SERVE_SUPERVISOR_STOP_EXIT_CODE) {
      return SERVE_SUPERVISOR_STOP_EXIT_CODE
    }
    if (result.code === SERVE_ALREADY_RUNNING_EXIT_CODE) {
      if (singletonRetryUsed || !args.recoverSingleton) {
        return SERVE_ALREADY_RUNNING_EXIT_CODE
      }
      const recovery = await args.recoverSingleton()
      if (recovery.state !== 'recovered') {
        const reason = recovery.state === 'active-owner' ? 'active_owner' : recovery.reason
        process.stderr.write(
          `[serve] singleton recovery refused (${reason}); leaving the profile unchanged.\n`
        )
        return SERVE_ALREADY_RUNNING_EXIT_CODE
      }
      singletonRetryUsed = true
      process.stderr.write(
        `[serve] quarantined stale Linux singleton artifacts for exited pid ${recovery.ownerPid}; retrying once.\n`
      )
      const replacement = await spawnRestartChild(args)
      if (!replacement) {
        return SERVE_SUPERVISOR_STOP_EXIT_CODE
      }
      child = replacement
      continue
    }

    if (result.healthyDurationMs >= (args.stableRunResetMs ?? SERVE_CRASH_BUDGET_RESET_MS)) {
      restartIndex = 0
    }
    if (restartIndex >= restartDelays.length) {
      process.stderr.write(
        `[serve] main-process recovery exhausted after ${restartDelays.length} restart attempts; exiting with code ${SERVE_SUPERVISOR_STOP_EXIT_CODE}.\n`
      )
      return SERVE_SUPERVISOR_STOP_EXIT_CODE
    }

    const delayMs = restartDelays[restartIndex]
    restartIndex += 1
    process.stderr.write(
      `[serve] main process became unavailable; restarting in ${delayMs}ms (${restartIndex}/${restartDelays.length}).\n`
    )
    await sleep(delayMs)
    const replacement = await spawnRestartChild(args)
    if (!replacement) {
      return SERVE_SUPERVISOR_STOP_EXIT_CODE
    }
    child = replacement
  }
}

async function spawnRestartChild(args: ServeSupervisorArgs): Promise<ChildProcess | null> {
  try {
    await args.beforeRestart?.()
    return args.spawnChild(args.executable, args.childArgs, args.spawnOptions)
  } catch (error) {
    process.stderr.write(
      `[serve] could not restart main process: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return null
  }
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

export async function readServeUpdateHandoff(
  handoffPath: string
): Promise<ServeUpdateHandoffState | null> {
  try {
    return parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))
  } catch {
    return null
  }
}

export function readServeUpdateHandoffSync(handoffPath: string): ServeUpdateHandoffState | null {
  try {
    return parseServeUpdateHandoffState(JSON.parse(readFileSync(handoffPath, 'utf8')))
  } catch {
    return null
  }
}

export async function clearServeUpdateHandoff(handoffPath: string): Promise<void> {
  await unlink(handoffPath).catch(() => undefined)
}

export async function completeServeUpdateHandoff(
  handoffPath: string,
  state: InstallRequestedHandoff,
  runtimeId: string
): Promise<void> {
  await writeServeUpdateHandoffState(handoffPath, {
    ...state,
    phase: 'completed',
    runtimeId
  })
  await clearServeUpdateHandoff(handoffPath)
}

export async function recordServeUpdateHandoffFailure(
  handoffPath: string,
  state: Extract<ServeUpdateHandoffState, { phase: 'install-requested' }>,
  reason: string
): Promise<void> {
  const failedState: ServeUpdateHandoffState = { ...state, phase: 'failed', reason }
  await writeServeUpdateHandoffState(handoffPath, failedState)
  process.stderr.write(`[serve] update handoff failed: ${reason}\n`)
}

async function writeServeUpdateHandoffState(
  handoffPath: string,
  state: ServeUpdateHandoffState
): Promise<void> {
  const temporaryPath = `${handoffPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 })
  await rename(temporaryPath, handoffPath)
}
