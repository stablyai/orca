import { writeFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app, dialog } from 'electron'
import {
  PROFILE_STATE_DESKTOP_RECOVERY_FLAG,
  PROFILE_STATE_RECOVERY_FLAG,
  PROFILE_STATE_RECOVERY_RESULT_PREFIX,
  ProfileStateRecoveryCommandError,
  isProfileStateRecoveryCommandError,
  profileStateRecoveryRequestSchema,
  type ProfileStateRecoveryResponse
} from '../../shared/profile-state-recovery-command'
import { translateMain } from '../i18n/main-i18n'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/profile-state-access'
import { rollbackProfileState } from '../persistence/profile-state/profile-state-recovery-command'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { acquireSingleInstanceLock } from './single-instance-lock'

/** The process owning both locks performs recovery before Electron can initialize a runtime. */
export function runProfileStateRecoveryPreflight(argv: readonly string[] = process.argv): boolean {
  if (argv.includes(PROFILE_STATE_DESKTOP_RECOVERY_FLAG)) {
    runDesktopRecovery(argv)
    return true
  }
  const index = argv.indexOf(PROFILE_STATE_RECOVERY_FLAG)
  if (index === -1) {
    return false
  }
  process.env.ORCA_BACKGROUND_LAUNCH = '1'
  applyBackgroundActivationPolicy()
  const response =
    !argv.includes('--serve') || argv.lastIndexOf(PROFILE_STATE_RECOVERY_FLAG) !== index
      ? invalidLaunch()
      : runRecoveryRequest(argv[index + 1])
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

/** Build the relaunch argv that applies a startup-dialog choice before ordinary startup. */
export function profileStateDesktopRecoveryArgs(
  argv: readonly string[],
  request: { userDataPath: string; selector: { kind: 'current-json' | 'current-sqlite' } }
): string[] {
  return [
    ...stripRecoveryArgs(argv.slice(1)),
    PROFILE_STATE_DESKTOP_RECOVERY_FLAG,
    JSON.stringify(request)
  ]
}

function runDesktopRecovery(argv: readonly string[]): void {
  const index = argv.indexOf(PROFILE_STATE_DESKTOP_RECOVERY_FLAG)
  const response =
    argv.lastIndexOf(PROFILE_STATE_DESKTOP_RECOVERY_FLAG) !== index ||
    argv.includes(PROFILE_STATE_RECOVERY_FLAG) ||
    argv.includes('--serve')
      ? invalidLaunch()
      : runRecoveryRequest(argv[index + 1])
  if (response.ok) {
    // Why relaunch: ordinary startup must run in a process that never held maintenance.
    app.relaunch({ args: stripRecoveryArgs(argv.slice(1)) })
    app.exit(0)
    return
  }
  console.error(`[profile-state] Desktop recovery failed: ${response.message}`)
  void app
    .whenReady()
    .then(() =>
      dialog.showMessageBox({
        type: 'error',
        buttons: [translateMain('profileState.recoveryNotApplied.quitButton', 'Quit')],
        title: translateMain(
          'profileState.recoveryNotApplied.title',
          'Orca profile state was not changed'
        ),
        message: translateMain(
          'profileState.recoveryNotApplied.message',
          'Orca could not apply the selected profile state.'
        ),
        detail: `${response.message}\n\n${translateMain(
          'profileState.recoveryNotApplied.reopenDetail',
          'Reopen Orca to choose again.'
        )}`
      })
    )
    .catch((error: unknown) => console.warn('[profile-state] Recovery error dialog failed:', error))
    .finally(() => app.exit(1))
}

function runRecoveryRequest(payload: string | undefined): ProfileStateRecoveryResponse {
  try {
    let raw: unknown
    try {
      raw = JSON.parse(payload ?? '')
    } catch {
      raw = undefined
    }
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
      return {
        ok: true,
        result: rollbackProfileState(
          userDataPath,
          parsed.data.selector,
          maintenance,
          parsed.data.profileId
        )
      }
    } finally {
      maintenance.release()
    }
  } catch (error) {
    return {
      ok: false,
      code: isProfileStateRecoveryCommandError(error) ? error.code : 'runtime_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function invalidLaunch(): ProfileStateRecoveryResponse {
  return {
    ok: false,
    code: 'invalid_argument',
    message: 'Invalid profile-state recovery launch.'
  }
}

function stripRecoveryArgs(args: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === PROFILE_STATE_DESKTOP_RECOVERY_FLAG ||
      args[i] === PROFILE_STATE_RECOVERY_FLAG
    ) {
      i++
      continue
    }
    kept.push(args[i])
  }
  return kept
}
