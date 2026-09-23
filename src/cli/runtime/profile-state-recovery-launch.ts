import { realpathSync } from 'node:fs'
import { runProcess } from '../../shared/child-process/run-process'
import {
  PROFILE_STATE_RECOVERY_FLAG,
  PROFILE_STATE_RECOVERY_RESULT_PREFIX,
  profileStateRecoveryResponseSchema,
  type ProfileStateRecoveryRequest,
  type ProfileStateRollbackResult
} from '../../shared/profile-state-recovery-command'
import {
  getExecutableAppArgs,
  resolveAppRoot,
  resolveForegroundOrcaExecutable,
  stripElectronRunAsNode
} from './launch'
import { RuntimeClientError } from './types'

export function canLaunchProfileStateRecovery(): boolean {
  return process.env.ELECTRON_RUN_AS_NODE === '1' || !!process.env.ORCA_APP_EXECUTABLE?.trim()
}

export async function launchProfileStateRecovery(
  request: ProfileStateRecoveryRequest
): Promise<ProfileStateRollbackResult> {
  const executable = resolveForegroundOrcaExecutable()
  const userDataPath = realpathSync(request.userDataPath)
  const response = await runProcess({
    program: executable,
    args: [
      ...getExecutableAppArgs(executable),
      '--serve',
      PROFILE_STATE_RECOVERY_FLAG,
      JSON.stringify({ ...request, userDataPath })
    ],
    cwd: resolveAppRoot(),
    env: {
      ...stripElectronRunAsNode(process.env),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_USER_DATA_PATH: userDataPath
    },
    // Recovery may copy large backups; the lock owner must finish or be explicitly terminated.
    timeoutMs: null
  })
  const lines = response.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(PROFILE_STATE_RECOVERY_RESULT_PREFIX))
  if (!response.outputTruncated && lines.length === 1) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[0].slice(PROFILE_STATE_RECOVERY_RESULT_PREFIX.length))
    } catch {
      throw new RuntimeClientError(
        'runtime_error',
        'Orca recovery returned an invalid response. Inspect retained recovery artifacts before retrying.'
      )
    }
    const result = profileStateRecoveryResponseSchema.safeParse(parsed)
    if (result.success) {
      if (!result.data.ok) {
        throw new RuntimeClientError(result.data.code, result.data.message)
      }
      if (response.code === 0 && !response.signal && !response.timedOut) {
        return result.data.result
      }
    }
  }
  throw new RuntimeClientError(
    'runtime_error',
    'Orca recovery did not complete successfully. Inspect retained recovery artifacts before retrying.'
  )
}
