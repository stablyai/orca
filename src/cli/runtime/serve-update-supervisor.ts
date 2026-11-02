import type { ChildProcessHandle, ProcessSpec } from '@orca/process-host/process-spec'
import { readFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import {
  parseServeSupervisorMessage,
  parseServeUpdateHandoffState,
  type ServeUpdateHandoffState
} from '../../shared/serve-update-handoff'
import {
  QUIT_RENDERER_ACK_TIMEOUT_MS,
  WILL_QUIT_TEARDOWN_DEADLINE_MS
} from '../../shared/quit-teardown-deadline'
import { serveSignalExitError } from './serve-signal-exit-diagnostic'
import { waitForMacBundleVersion } from './mac-app-update-bundle'
import {
  mayRespawn,
  supervisedStopSignal,
  trackServeChild,
  untrackServeChild
} from './serve-supervised-stop'
import {
  decideAfterServeChildExit,
  type InstallRequestedHandoff,
  type ServeReadiness
} from './serve-supervisor-policy'

export const SERVE_REPLACEMENT_READY_TIMEOUT_MS = 60_000
export const SERVE_CHILD_FORCE_KILL_SCHEDULING_MARGIN_MS = 5_000
export const SERVE_CHILD_FORCE_KILL_GRACE_MS =
  QUIT_RENDERER_ACK_TIMEOUT_MS +
  WILL_QUIT_TEARDOWN_DEADLINE_MS +
  SERVE_CHILD_FORCE_KILL_SCHEDULING_MARGIN_MS

type ServeSupervisorArgs = {
  /** Respawned on update; `program` is also the bundle whose installed version a handoff awaits. */
  spec: ProcessSpec
  spawnChild: (spec: ProcessSpec) => ChildProcessHandle
  handoffPath: string | null
}

export async function resumeInterruptedServeUpdate(
  args: ServeSupervisorArgs & { handoffPath: string; handoff: InstallRequestedHandoff }
): Promise<number> {
  const expectedHandoff = await awaitInstalledHandoff(
    args.spec.program,
    args.handoffPath,
    args.handoff
  )
  if (!(await mayRespawn())) {
    return 0
  }
  const child = args.spawnChild(args.spec)
  return superviseForegroundServe({ ...args, child, expectedHandoff })
}

async function awaitInstalledHandoff(
  executable: string,
  handoffPath: string,
  handoff: InstallRequestedHandoff
): Promise<InstallRequestedHandoff | null> {
  const stop = supervisedStopSignal()
  if (await waitForMacBundleVersion(executable, handoff.targetVersion, undefined, stop)) {
    return handoff
  }
  if (stop.aborted) {
    // A stop is not a failed update: the next start resumes this handoff.
    return null
  }
  await recordServeUpdateHandoffFailure(
    handoffPath,
    handoff,
    `Timed out waiting for Orca ${handoff.targetVersion} to be installed.`
  )
  return null
}

export async function superviseForegroundServe(
  args: ServeSupervisorArgs & {
    child: ChildProcessHandle
    expectedHandoff: InstallRequestedHandoff | null
  }
): Promise<number> {
  let child = args.child
  let expectedHandoff = args.expectedHandoff

  while (true) {
    const result = await waitForForegroundChild(
      child,
      args.handoffPath && expectedHandoff
        ? { handoffPath: args.handoffPath, handoff: expectedHandoff }
        : null
    )
    const decision = decideAfterServeChildExit({
      exit: { ...result, childPid: child.pid },
      expectedHandoff,
      handoff:
        result.readiness === 'failed' || (expectedHandoff && result.readiness !== 'verified')
          ? null
          : args.handoffPath
            ? await readServeUpdateHandoff(args.handoffPath)
            : null,
      hasHandoffPath: args.handoffPath !== null
    })
    switch (decision.kind) {
      case 'exit':
        return decision.code
      case 'fail-replacement':
        if (args.handoffPath) {
          await recordServeUpdateHandoffFailure(args.handoffPath, decision.handoff, decision.reason)
        }
        return 1
      case 'signal-exit':
        throw serveSignalExitError(decision.signal)
      case 'await-install':
        if (!args.handoffPath) {
          return 1
        }
        expectedHandoff = await awaitInstalledHandoff(
          args.spec.program,
          args.handoffPath,
          decision.handoff
        )
        if (!(await mayRespawn())) {
          return 0
        }
        child = args.spawnChild(args.spec)
    }
  }
}

function waitForForegroundChild(
  child: ChildProcessHandle,
  expected: { handoffPath: string; handoff: InstallRequestedHandoff } | null
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  readiness: ServeReadiness
  signalWasForwarded: boolean
}> {
  return new Promise((resolveWait, reject) => {
    const forwardsHangup = process.platform === 'linux'
    const forwardedSignals = new Set<NodeJS.Signals>()
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    let readyTimer: ReturnType<typeof setTimeout> | null = null
    let readiness: ServeReadiness = expected ? 'pending' : 'not-expected'
    let stateWrite = Promise.resolve()
    let childSettled = false
    const terminateChild = (): void => {
      if (childSettled) {
        return
      }
      child.kill('SIGTERM')
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), SERVE_CHILD_FORCE_KILL_GRACE_MS)
    }
    const recordReplacementFailure = (reason: string): boolean => {
      if (!expected || readiness !== 'pending') {
        return false
      }
      readiness = 'failed'
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
      stateWrite = recordServeUpdateHandoffFailure(
        expected.handoffPath,
        expected.handoff,
        reason
      ).catch((error) => {
        process.stderr.write(`[serve] could not record update handoff failure: ${String(error)}\n`)
      })
      return true
    }
    const rejectReplacement = (reason: string): void => {
      if (!recordReplacementFailure(reason)) {
        return
      }
      terminateChild()
    }
    const forwardSignal = (signal: NodeJS.Signals): void => {
      // A Windows console delivers Ctrl-C to parent and child; child.kill would terminate the child mid-teardown.
      if (process.platform !== 'win32') {
        forwardedSignals.add(signal)
        child.kill(signal)
      }
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), SERVE_CHILD_FORCE_KILL_GRACE_MS)
    }
    const tracked = { pid: child.pid ?? null, stop: () => forwardSignal('SIGTERM') }
    const handleMessage = (value: unknown): void => {
      const message = parseServeSupervisorMessage(value)
      if (!message || !expected || readiness !== 'pending') {
        return
      }
      if (message.version !== expected.handoff.targetVersion) {
        rejectReplacement(
          `Replacement reported version ${message.version}; expected ${expected.handoff.targetVersion}.`
        )
        return
      }
      readiness = 'verified'
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
      stateWrite = completeServeUpdateHandoff(
        expected.handoffPath,
        expected.handoff,
        message.runtimeId
      ).catch((error) => {
        readiness = 'failed'
        process.stderr.write(`[serve] could not complete update handoff: ${String(error)}\n`)
        terminateChild()
      })
    }
    const cleanup = (): void => {
      untrackServeChild(tracked)
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
      if (forwardsHangup) {
        process.off('SIGHUP', forwardSignal)
      }
      if (typeof child.off === 'function') {
        child.off('message', handleMessage)
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      if (readyTimer) {
        clearTimeout(readyTimer)
      }
    }
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    if (forwardsHangup) {
      process.on('SIGHUP', forwardSignal)
    }
    if (typeof child.on === 'function') {
      child.on('message', handleMessage)
    }
    trackServeChild(tracked)
    if (expected) {
      readyTimer = setTimeout(() => {
        rejectReplacement(
          `Replacement did not report serving version ${expected.handoff.targetVersion} within ${SERVE_REPLACEMENT_READY_TIMEOUT_MS}ms.`
        )
      }, SERVE_REPLACEMENT_READY_TIMEOUT_MS)
    }
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      childSettled = true
      cleanup()
      const signalWasForwarded = signal !== null && forwardedSignals.has(signal)
      void stateWrite.then(() => resolveWait({ code, signal, readiness, signalWasForwarded }))
    }
    child.once('error', (error) => {
      childSettled = true
      recordReplacementFailure(`Could not start the replacement process: ${String(error)}`)
      cleanup()
      child.off('exit', handleExit)
      // Persist failure before rejection: launchd may immediately restart this parent.
      void stateWrite.then(() => reject(error))
    })
    child.once('exit', handleExit)
  })
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
  await unlink(handoffPath).catch(() => undefined)
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
