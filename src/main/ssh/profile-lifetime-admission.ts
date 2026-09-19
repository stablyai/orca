import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { acquireProfileLifetimeLock } from './profile-lifetime-lock'
import { captureSshResetProfileIdentity } from './ssh-reset-profile-identity'
import { captureProfileLifetimeParticipation } from './profile-lifetime-participation'

let ownership:
  | {
      identity: ReturnType<typeof captureSshResetProfileIdentity>
      lock: ReturnType<typeof acquireProfileLifetimeLock>
    }
  | undefined
let failure: Error | undefined
let unprotectedWorkAdmitted = false
const processIncarnation = randomUUID()

const enabled = () => process.env.ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION === '1'

/** Opt-in until packaging and durable originating-client participation are complete. */
export function initializeProfileLifetimeAdmission(root: string): void {
  if (failure) {
    throw failure
  }
  if (ownership) {
    assertProfileLifetimeAdmission()
    if (captureSshResetProfileIdentity(root).physicalPath !== ownership.identity.physicalPath) {
      failure = new Error('profile_lifetime_admission_root_changed')
      throw failure
    }
    return
  }
  if (!enabled()) {
    return
  }
  try {
    if (unprotectedWorkAdmitted) {
      throw new Error('profile_lifetime_admission_too_late')
    }
    const addon = process.env.ORCA_PROFILE_LIFETIME_LOCK_ADDON
    if (!isAbsolute(root) || !addon || !isAbsolute(addon)) {
      throw new Error('profile_lifetime_admission_configuration_invalid')
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const identity = captureSshResetProfileIdentity(root)
    const binding = createRequire(join(identity.physicalPath, 'profile-lock-loader.cjs'))(addon)
    const lock = acquireProfileLifetimeLock(root, binding)
    // No early-release API: quit deadlines and runtime.stop() do not prove process retirement.
    ownership = { identity, lock }
    assertProfileLifetimeAdmission()
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    throw failure
  }
}

/** Control-plane admission only; never evidence of remote execution retirement. */
export function assertProfileLifetimeAdmission(): void {
  if (failure) {
    throw failure
  }
  if (ownership) {
    try {
      ownership.identity.assertCurrent()
      ownership.lock.assertCurrent()
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      throw failure
    }
  } else if (enabled()) {
    throw new Error('profile_lifetime_admission_not_initialized')
  } else {
    unprotectedWorkAdmitted = true
  }
}

export function readCurrentProfileLifetimeParticipation() {
  assertProfileLifetimeAdmission()
  if (!ownership) {
    return null
  }
  return captureProfileLifetimeParticipation(
    ownership.identity.physicalPath,
    processIncarnation,
    assertProfileLifetimeAdmission
  )
}
