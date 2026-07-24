import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import {
  parseServeSupervisorMessage,
  parseServeUpdateHandoffState,
  type ServeUpdateHandoffState
} from '../../shared/serve-update-handoff'
import { RuntimeClientError } from './types'
import { waitForMacBundleVersion } from './mac-app-update-bundle'

export const SERVE_REPLACEMENT_READY_TIMEOUT_MS = 60_000

type InstallRequestedHandoff = Extract<ServeUpdateHandoffState, { phase: 'install-requested' }>
type ServeReadiness = 'not-expected' | 'pending' | 'verified' | 'failed'

type ServeSupervisorArgs = {
  executable: string
  childArgs: string[]
  spawnOptions: SpawnOptions
  spawnChild: typeof spawn
  handoffPath: string | null
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

  while (true) {
    const result = await waitForForegroundChild(
      child,
      args.handoffPath && expectedHandoff
        ? { handoffPath: args.handoffPath, handoff: expectedHandoff }
        : null
    )

    if (result.readiness === 'failed') {
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
      handoff?.phase !== 'install-requested' ||
      (child.pid !== undefined && handoff.servingPid !== child.pid)
    ) {
      if (typeof result.code === 'number') {
        return result.code
      }
      throw new RuntimeClientError('runtime_serve_failed', `Orca serve exited via ${result.signal}`)
    }

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
    child = args.spawnChild(args.executable, args.childArgs, args.spawnOptions)
  }
}

function waitForForegroundChild(
  child: ChildProcess,
  expected: { handoffPath: string; handoff: InstallRequestedHandoff } | null
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  readiness: ServeReadiness
}> {
  return new Promise((resolveWait, reject) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    let readyTimer: ReturnType<typeof setTimeout> | null = null
    let readiness: ServeReadiness = expected ? 'pending' : 'not-expected'
    let stateWrite = Promise.resolve()
    const terminateChild = (): void => {
      child.kill('SIGTERM')
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000)
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
      child.kill(signal)
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000)
    }
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
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
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
    if (typeof child.on === 'function') {
      child.on('message', handleMessage)
    }
    if (expected) {
      readyTimer = setTimeout(() => {
        rejectReplacement(
          `Replacement did not report serving version ${expected.handoff.targetVersion} within ${SERVE_REPLACEMENT_READY_TIMEOUT_MS}ms.`
        )
      }, SERVE_REPLACEMENT_READY_TIMEOUT_MS)
    }
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      void stateWrite.then(() => resolveWait({ code, signal, readiness }))
    }
    child.once('error', (error) => {
      recordReplacementFailure(`Could not start the replacement process: ${String(error)}`)
      cleanup()
      child.off('exit', handleExit)
      // Why: the LaunchAgent may restart this parent immediately, so durable failure must precede process rejection.
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
