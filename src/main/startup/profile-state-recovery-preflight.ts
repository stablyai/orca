import { writeFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app } from 'electron'
import {
  PROFILE_STATE_RECOVERY_FLAG,
  PROFILE_STATE_RECOVERY_RESULT_PREFIX,
  ProfileStateRecoveryCommandError,
  isProfileStateRecoveryCommandError,
  profileStateRecoveryRequestSchema,
  type ProfileStateRecoveryResponse
} from '../../shared/profile-state-recovery-command'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/profile-state-access'
import { rollbackProfileState } from '../persistence/profile-state/profile-state-recovery-command'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { acquireSingleInstanceLock } from './single-instance-lock'

/** The process owning both locks performs recovery before Electron can initialize a runtime. */
export function runProfileStateRecoveryPreflight(argv: readonly string[] = process.argv): boolean {
  const index = argv.indexOf(PROFILE_STATE_RECOVERY_FLAG)
  if (index === -1) {
    return false
  }
  process.env.ORCA_BACKGROUND_LAUNCH = '1'
  applyBackgroundActivationPolicy()
  let response: ProfileStateRecoveryResponse
  try {
    if (!argv.includes('--serve') || argv.lastIndexOf(PROFILE_STATE_RECOVERY_FLAG) !== index) {
      throw new ProfileStateRecoveryCommandError(
        'invalid_argument',
        'Invalid profile-state recovery launch.'
      )
    }
    const raw: unknown = JSON.parse(argv[index + 1] ?? '')
    const parsed = profileStateRecoveryRequestSchema.safeParse(raw)
    if (!parsed.success || !isAbsolute(parsed.data.userDataPath)) {
      throw new ProfileStateRecoveryCommandError(
        'invalid_argument',
        'Invalid profile-state recovery request.'
      )
    }
    const userDataPath = realpathSync(parsed.data.userDataPath)
    app.setPath('userData', userDataPath)
    process.env.ORCA_USER_DATA_PATH = userDataPath
    const maintenance = acquireProfileStateMaintenance(userDataPath)
    try {
      // Force Electron's lock even when ordinary dev or diagnostic launches would bypass it.
      if (!acquireSingleInstanceLock(app, () => {})) {
        throw new ProfileStateRecoveryCommandError(
          'runtime_error',
          'Stop Orca before profile-state rollback so no process can write the SQLite database.'
        )
      }
      response = {
        ok: true,
        result: rollbackProfileState(userDataPath, parsed.data.selector, maintenance)
      }
    } finally {
      maintenance.release()
    }
  } catch (error) {
    response = {
      ok: false,
      code: isProfileStateRecoveryCommandError(error) ? error.code : 'runtime_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
  let exitCode = response.ok ? 0 : 1
  try {
    writeFileSync(1, `${PROFILE_STATE_RECOVERY_RESULT_PREFIX}${JSON.stringify(response)}\n`)
  } catch {
    // The CLI may have exited while recovery held the locks; never open an Electron error dialog.
    exitCode = 1
  }
  app.exit(exitCode)
  return true
}
