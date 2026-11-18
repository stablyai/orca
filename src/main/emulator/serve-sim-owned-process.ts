import type { ChildProcess } from 'node:child_process'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { EmulatorError } from './emulator-errors'
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
  const results = await Promise.allSettled(
    sessions
      .filter((session) => !session.stopping)
      .map((session) => stop(session.info.deviceUdid, session.info.helperPid))
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    throw failure.reason
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
