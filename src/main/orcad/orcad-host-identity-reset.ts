// CLI entry for `orca serve reset-identity`; plain Node, loaded from the packaged CLI.
import { existsSync } from 'node:fs'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import {
  HostIdentityRotationNotStartedError,
  rotateHostIdentity
} from '../runtime/host-instance-identity'

export type HostIdentityResetResult =
  | { status: 'reset' }
  | { status: 'missing' }
  | { status: 'running'; message: string }
  /** Nothing changed on disk. */
  | { status: 'failed'; message: string }
  /** The next Orca start finishes the rotation before it serves pairing. */
  | { status: 'incomplete'; message: string }

const RUNNING_LOCK_CODES: ReadonlySet<string> = new Set([
  'orcad_instance_lock_held',
  'orcad_instance_lock_holder_unverifiable'
])

/** Holds the profile lock so no running Orca reads or rewrites the files mid-rotation. */
export function resetHostIdentityUnderLock(userDataPath: string): HostIdentityResetResult {
  if (!existsSync(userDataPath)) {
    return { status: 'missing' }
  }
  let lock: ReturnType<typeof acquireOrcadInstanceLock>
  try {
    // The path may be a desktop profile, whose permissions a reset must not change.
    lock = acquireOrcadInstanceLock(userDataPath, { enforcePrivateDataRoot: false })
  } catch (error) {
    // Other lock errors (an unusable or shared data root) carry their own guidance.
    if (error instanceof OrcadInstanceLockError && RUNNING_LOCK_CODES.has(error.code)) {
      return { status: 'running', message: error.message }
    }
    throw error
  }
  try {
    rotateHostIdentity(userDataPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return error instanceof HostIdentityRotationNotStartedError
      ? { status: 'failed', message }
      : { status: 'incomplete', message }
  } finally {
    lock.release()
  }
  return { status: 'reset' }
}
