import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'
import {
  brakeForBuild,
  clearServeSupervisorBrake,
  readServeSupervisorBrake,
  recordSupervisedFailure,
  SERVE_GAVE_UP_ADVICE,
  standbyDelayMs,
  writeServeSupervisorBrake,
  type ServeSupervisorBrake
} from './serve-supervisor-brake'
import {
  readServeInstallEvidence,
  serveBuildIdentity,
  SERVE_INSTALL_HOLD_REASON_TEXT,
  type ServeInstallEvidence
} from './serve-install-hold'
import {
  currentServeChild,
  requestSupervisedServeStop,
  resetSupervisedServeStop
} from './serve-supervised-stop'
import type { ServeBundlePark } from '../../shared/serve-bundle-park'
import { createSupervisedParkWatch } from './serve-supervised-park-watch'
import type { AppImageBuildState } from './serve-appimage-update'

export const SERVE_INSTALL_HOLD_POLL_MS = 2_000
/** A hold this long is reported as stuck; it still never times out into a spawn. */
export const SERVE_INSTALL_HOLD_STUCK_MS = 30 * 60_000
/** A version-specific executable this long gone was removed by an update, not swapped by one. */
export const SERVE_EXECUTABLE_MISSING_EXIT_MS = 2 * 60_000

type StopListener = () => void

export type SupervisedServeOptions = {
  userDataPath: string
  executable: string
  /** Part of the build identity: the app archive changes with every release. */
  appRoot?: string
  force: boolean
  /** One full serve attempt: preflight, spawn, and the existing update-aware wait. */
  runOnce: () => Promise<number>
  readInstallEvidence?: (executable: string) => Promise<ServeInstallEvidence>
  buildIdentity?: (executable: string) => string
  readBrake?: (userDataPath: string) => ServeSupervisorBrake | null
  writeBrake?: (userDataPath: string, record: ServeSupervisorBrake) => void
  clearBrake?: (userDataPath: string) => void
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, ms: number) => () => void
  onStopSignal?: (listener: StopListener) => () => void
  log?: (line: string) => void
  /** The desktop-install park protocol; null when this supervisor does not take part. */
  park?: ServeBundlePark | null
  currentChild?: typeof currentServeChild
  setRepeating?: (callback: () => void, ms: number) => () => void
  /** The AppImage this build was unpacked from, checked before each start; null elsewhere. */
  appImageUpdate?: SupervisedAppImageUpdate | null
}

export type SupervisedAppImageUpdate = {
  inspect: () => AppImageBuildState
  /** Re-execs into the new build and never returns; otherwise resolves with why it could not. */
  restart: (isStopped: () => boolean) => Promise<string>
}

export function getServeSuperviseValidationError(input: {
  supervise: boolean
  recipeJson: boolean
  platform?: NodeJS.Platform
}): string | null {
  if (!input.supervise) {
    return null
  }
  if ((input.platform ?? process.platform) === 'win32') {
    return '--supervise is not supported on Windows yet. Run `orca serve` under your own service wrapper instead.'
  }
  if (input.recipeJson) {
    return '--recipe-json starts a detached server and returns; it cannot be combined with --supervise.'
  }
  return null
}

function defaultOnStopSignal(listener: StopListener): () => void {
  const signals: NodeJS.Signals[] =
    process.platform === 'linux' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM']
  for (const signal of signals) {
    process.on(signal, listener)
  }
  return () => {
    for (const signal of signals) {
      process.off(signal, listener)
    }
  }
}

function defaultSetTimer(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

function defaultSetRepeating(callback: () => void, ms: number): () => void {
  const timer = setInterval(callback, ms)
  return () => clearInterval(timer)
}

async function settle(run: () => Promise<number>): Promise<PromiseSettledResult<number>> {
  try {
    return { status: 'fulfilled', value: await run() }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}

/**
 * `orca serve --supervise`: the restart owner for a service manager. It never exits because its
 * child died; it exits on a stop signal, or with 0 after giving up so the manager stops too.
 */
export async function superviseServeService(options: SupervisedServeOptions): Promise<number> {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const setTimer = options.setTimer ?? defaultSetTimer
  const readEvidence = options.readInstallEvidence ?? readServeInstallEvidence
  const identify =
    options.buildIdentity ??
    ((executable: string) => serveBuildIdentity(executable, options.appRoot))
  const writeBrake = options.writeBrake ?? writeServeSupervisorBrake

  // Why not keyed yet: mid-install the executable may be missing, which must not reset a give-up.
  let record: ServeSupervisorBrake | null = (options.readBrake ?? readServeSupervisorBrake)(
    options.userDataPath
  )
  if (options.force) {
    ;(options.clearBrake ?? clearServeSupervisorBrake)(options.userDataPath)
    record = null
  }
  const refuseGaveUp = (gaveUp: { reason: string }): number => {
    log(`[serve] Not starting: ${gaveUp.reason} ${SERVE_GAVE_UP_ADVICE}`)
    return 0
  }
  // Why the AppImage check: a replaced AppImage is a new build, which a give-up must not block.
  if (
    record?.gaveUp &&
    record.build === identify(options.executable) &&
    (options.appImageUpdate?.inspect() ?? 'current') === 'current'
  ) {
    return refuseGaveUp(record.gaveUp)
  }

  const parkWatch = options.park
    ? createSupervisedParkWatch(options.park, {
        currentChild: options.currentChild ?? currentServeChild,
        setRepeating: options.setRepeating ?? defaultSetRepeating,
        now
      })
    : null
  let stopped = false
  let wake: (() => void) | null = null
  const removeStopListener = (options.onStopSignal ?? defaultOnStopSignal)(() => {
    stopped = true
    requestSupervisedServeStop()
    wake?.()
  })
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolveSleep) => {
      if (stopped) {
        resolveSleep()
        return
      }
      const cancel = setTimer(() => {
        wake = null
        resolveSleep()
      }, ms)
      wake = () => {
        wake = null
        cancel()
        resolveSleep()
      }
    })

  const awaitClearToSpawn = async (): Promise<boolean> => {
    const since = now()
    while (!stopped) {
      const evidence: ServeInstallEvidence = parkWatch?.idle()
        ? { kind: 'hold', reason: 'install-park' }
        : await readEvidence(options.executable)
      if (evidence.kind === 'clear') {
        return !stopped
      }
      if (
        evidence.reason === 'bundle-missing' &&
        now() - since >= SERVE_EXECUTABLE_MISSING_EXIT_MS
      ) {
        // The outer loop sees the same hold and hands the restart to the service manager.
        return false
      }
      await sleep(SERVE_INSTALL_HOLD_POLL_MS)
    }
    return false
  }
  resetSupervisedServeStop(awaitClearToSpawn, () => options.park?.holds() ?? false)

  let appImageUpdate = options.appImageUpdate ?? null
  try {
    let standbyAttempt = 0
    const hold: { current: { reason: string; since: number; reportedStuck: boolean } | null } = {
      current: null
    }
    while (!stopped) {
      const evidence: ServeInstallEvidence = parkWatch?.idle()
        ? { kind: 'hold', reason: 'install-park' }
        : await readEvidence(options.executable)
      if (stopped) {
        break
      }
      if (evidence.kind === 'hold') {
        const held = hold.current
        if (held?.reason !== evidence.reason) {
          hold.current = { reason: evidence.reason, since: now(), reportedStuck: false }
          log(
            `[serve] Waiting before starting Orca serve: ${SERVE_INSTALL_HOLD_REASON_TEXT[evidence.reason]}.`
          )
        } else if (
          evidence.reason === 'bundle-missing' &&
          now() - held.since >= SERVE_EXECUTABLE_MISSING_EXIT_MS
        ) {
          // Why exit 1: the manager restarts the CLI through the stable launcher, which finds the installed build.
          log(
            '[serve] The Orca executable this service started from is gone; exiting so the service manager starts the installed Orca.'
          )
          return 1
        } else if (!held.reportedStuck && now() - held.since >= SERVE_INSTALL_HOLD_STUCK_MS) {
          held.reportedStuck = true
          log(
            `[serve] Still waiting after ${SERVE_INSTALL_HOLD_STUCK_MS / 60_000} minutes: ${SERVE_INSTALL_HOLD_REASON_TEXT[evidence.reason]}. Stop the service and start it again once the install is done.`
          )
        }
        await sleep(SERVE_INSTALL_HOLD_POLL_MS)
        continue
      }
      hold.current = null
      const appImage = appImageUpdate?.inspect() ?? 'current'
      if (appImage === 'settling') {
        // Why: the AppImage file is still being written; starting either build now would be wrong.
        await sleep(SERVE_INSTALL_HOLD_POLL_MS)
        continue
      }
      if (appImage === 'superseded' && appImageUpdate) {
        const reason = await appImageUpdate.restart(() => stopped)
        // One attempt per supervisor: a failed restart keeps serving the running build.
        appImageUpdate = null
        log(`[serve] Kept the running build: ${reason}.`)
        continue
      }
      record = brakeForBuild(record, identify(options.executable))
      if (record.gaveUp) {
        return refuseGaveUp(record.gaveUp)
      }

      const attempt = parkWatch
        ? await parkWatch.during(options.runOnce)
        : { parked: false, settled: await settle(options.runOnce) }
      if (stopped) {
        break
      }
      if (attempt.parked) {
        // Why not a failure: the desktop stopped this server to install an update.
        continue
      }
      let failure: string
      if (attempt.settled.status === 'fulfilled') {
        const code = attempt.settled.value
        if (code === SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE) {
          // Why not a failure: another Orca serves this profile, so wait for it instead of racing it.
          const delayMs = standbyDelayMs(standbyAttempt++, random)
          log(
            `[serve] Another Orca serves this profile; checking again in ${Math.round(delayMs / 1000)}s.`
          )
          await sleep(delayMs)
          continue
        }
        failure = `exited with code ${code}`
      } else {
        const error: unknown = attempt.settled.reason
        // Why: the child's own errors read "Orca serve exited via SIGKILL."; the log line names serve once.
        failure = (error instanceof Error ? error.message : String(error))
          .replace(/^Orca serve /, '')
          .replace(/\.$/, '')
      }
      standbyAttempt = 0
      const next = recordSupervisedFailure(record, { now: now(), reason: failure, random })
      record = next.record
      writeBrake(options.userDataPath, record)
      if (next.action.kind === 'give-up') {
        log(`[serve] ${next.action.reason}`)
        return 0
      }
      log(
        `[serve] Orca serve ${failure}; restarting in ${Math.max(1, Math.round(next.action.delayMs / 1000))}s.`
      )
      await sleep(next.action.delayMs)
    }
    return 0
  } finally {
    removeStopListener()
    resetSupervisedServeStop()
    parkWatch?.close()
  }
}
