// CLI entry for `orca serve reset-identity`; plain Node, loaded from the packaged CLI.
import { existsSync } from 'node:fs'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { rotateHostIdentity } from '../runtime/host-instance-identity'

export type HostIdentityResetResult =
  | { status: 'reset' }
  | { status: 'missing' }
  | { status: 'running'; message: string }

/** Holds the profile lock so no running Orca reads or rewrites the files mid-rotation. */
export function resetHostIdentityUnderLock(userDataPath: string): HostIdentityResetResult {
  if (!existsSync(userDataPath)) {
    return { status: 'missing' }
  }
  let lock: ReturnType<typeof acquireOrcadInstanceLock>
  try {
    lock = acquireOrcadInstanceLock(userDataPath)
  } catch (error) {
    if (error instanceof OrcadInstanceLockError) {
      return { status: 'running', message: error.message }
    }
    throw error
  }
  try {
    rotateHostIdentity(userDataPath)
  } finally {
    lock.release()
  }
  return { status: 'reset' }
}
