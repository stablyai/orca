import type { ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { EmulatorError } from './emulator-errors'
import { SimulatorShutdownError } from './simctl-simulator-devices'
import type { EmulatorSessionInfo } from './emulator-types'

export async function stopOwnedSimulatorChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Simulator helper did not exit; ownership retained.')),
      5_000
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    if (!child.kill()) {
      clearTimeout(timer)
      reject(new Error('Could not stop simulator helper; ownership retained.'))
    }
  })
}

export function simulatorOwnershipRoot(): string {
  const accountHome = userInfo().homedir
  if (!isAbsolute(accountHome)) {
    throw new EmulatorError(
      'emulator_helper_failed',
      'Cannot resolve the operating-system account home for simulator ownership.'
    )
  }
  return join(accountHome, 'Library', 'Application Support', 'orca', 'simulator-ownership')
}

export function ownedSimulatorStateRoot(
  session: { child: ChildProcess; stateRoot: string } | undefined,
  udid: string
): string {
  if (!session || session.child.exitCode !== null || session.child.signalCode !== null) {
    throw new EmulatorError(
      'emulator_no_active',
      `No owned simulator session for ${udid}; attach it first.`
    )
  }
  return session.stateRoot
}

export async function stopOwnedSimulatorHelpers(
  sessions: { info: EmulatorSessionInfo; stopping: boolean }[],
  stop: (udid: string, pid?: number) => Promise<void>
): Promise<void> {
  const retained = sessions.some((session) => session.stopping)
  const results = await Promise.allSettled(
    sessions
      .filter((session) => !session.stopping)
      .map((session) => stop(session.info.deviceUdid, session.info.helperPid))
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    throw failure.reason
  }
  if (retained) {
    throw new Error('Simulator helper ownership retained; cleanup is incomplete.')
  }
}

export function ownsSimulatorSession(
  session: { info: EmulatorSessionInfo; child: ChildProcess } | undefined,
  info: EmulatorSessionInfo
): boolean {
  return (
    !!session &&
    session.info.helperPid === info.helperPid &&
    session.info.streamUrl === info.streamUrl &&
    session.child.exitCode === null &&
    session.child.signalCode === null
  )
}

export function ownsSimulatorEndpoint(
  session: { info: EmulatorSessionInfo; child: ChildProcess } | undefined,
  endpoint: string | undefined
): boolean {
  return (
    !!session &&
    ownsSimulatorSession(session, session.info) &&
    (endpoint === session.info.wsUrl || endpoint === session.info.axUrl)
  )
}

export async function stopOwnedSimulatorSession(
  sessions: Map<
    string,
    {
      info: EmulatorSessionInfo
      child: ChildProcess
      stateRoot: string
      lock: string
      stopping: boolean
      stopInProgress: boolean
      uncertainShutdown: boolean
    }
  >,
  stopChild: typeof stopOwnedSimulatorChild,
  udid: string,
  helperPid?: number,
  shutdown?: (markIssued: () => void) => Promise<void>,
  releaseOnShutdownFailure = false,
  onHelperStopped?: () => void
): Promise<void> {
  const session = sessions.get(udid)
  if (!session) {
    if (helperPid !== undefined && !shutdown) {
      return
    }
    throw new EmulatorError('emulator_no_active', `No owned simulator helper for ${udid}.`)
  }
  if (helperPid !== undefined && session.info.helperPid !== helperPid) {
    throw new EmulatorError(
      'emulator_helper_failed',
      `Simulator ${udid} helper changed before it could be stopped.`
    )
  }
  if (session.stopInProgress) {
    throw new EmulatorError('emulator_helper_failed', `Simulator ${udid} is already stopping.`)
  }
  if (session.uncertainShutdown) {
    throw new EmulatorError(
      'emulator_helper_failed',
      `Simulator ${udid} has an uncertain shutdown; ownership retained.`
    )
  }
  session.stopping = true
  session.stopInProgress = true
  let stopped = false
  let shutdownSettled = false
  try {
    await stopChild(session.child)
    stopped = true
    onHelperStopped?.()
    if (shutdown) {
      try {
        await shutdown(() => {
          session.uncertainShutdown = true
        })
        session.uncertainShutdown = false
      } finally {
        shutdownSettled = true
      }
    }
    rmSync(session.stateRoot, { recursive: true, force: true })
    rmSync(session.lock, { recursive: true, force: true })
    if (sessions.get(udid) === session) {
      sessions.delete(udid)
    }
  } catch (error) {
    if (error instanceof SimulatorShutdownError && error.completed) {
      session.uncertainShutdown = false
    }
    if (
      releaseOnShutdownFailure &&
      stopped &&
      shutdownSettled &&
      error instanceof SimulatorShutdownError &&
      error.completed
    ) {
      rmSync(session.stateRoot, { recursive: true, force: true })
      rmSync(session.lock, { recursive: true, force: true })
      if (sessions.get(udid) === session) {
        sessions.delete(udid)
      }
    } else if (session.child.exitCode === null && session.child.signalCode === null) {
      session.stopping = false
    }
    throw error
  } finally {
    session.stopInProgress = false
  }
}
