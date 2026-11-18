import type { ChildProcess } from 'node:child_process'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { EmulatorError } from './emulator-errors'

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
