import { runProcess } from '@orca/process-host'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionStatus,
  ComputerUsePermissionStatusResult
} from '../../../shared/computer/computer-use-permissions-types'
import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from '../macos-native/macos-native-provider-paths'
import { RuntimeClientError } from '../runtime-client-error'

// Covers both settled TCC reads (up to ~2 s each, run in parallel) with room for a slow spawn.
const PERMISSION_STATUS_HELPER_TIMEOUT_MS = 10_000

type HelperPermissionStatus = Partial<
  Record<ComputerUsePermissionId, ComputerUsePermissionStatus> & { sessionLocked: boolean }
>

// onHelperSpawn fires when the helper actually starts, so launch budgets measure real spawns.
export function getComputerUsePermissionStatus(
  onHelperSpawn: () => void = () => {}
): Promise<ComputerUsePermissionStatusResult> {
  return getComputerUsePermissionStatusAsync(onHelperSpawn)
}

async function getComputerUsePermissionStatusAsync(
  onHelperSpawn: () => void
): Promise<ComputerUsePermissionStatusResult> {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      helperAppPath: null,
      helperUnavailableReason: null,
      permissions: [
        { id: 'accessibility', status: 'unsupported' },
        { id: 'screenshots', status: 'unsupported' }
      ]
    }
  }

  const helperAppPath = resolveMacOSComputerUseAppPath()
  const executablePath = resolveMacOSComputerUseExecutablePath()
  const unavailableReason = resolveComputerUseHelperUnavailableReason()
  if (!helperAppPath || !executablePath || unavailableReason) {
    return createUnavailablePermissionStatus(
      unavailableReason ?? 'Orca Computer Use.app was not found',
      helperAppPath
    )
  }

  const raw = await readPermissionStatusFromHelper(executablePath, onHelperSpawn)

  return {
    platform: process.platform,
    helperAppPath,
    helperUnavailableReason: null,
    permissions: [
      { id: 'accessibility', status: raw.accessibility ?? 'not-granted' },
      { id: 'screenshots', status: raw.screenshots ?? 'not-granted' }
    ],
    sessionLocked: raw.sessionLocked === true
  }
}

// Answers from the bundle layout alone, without launching the helper.
export function resolveComputerUseHelperUnavailableReason(): string | null {
  const helperAppPath = resolveMacOSComputerUseAppPath()
  if (!helperAppPath) {
    return 'Orca Computer Use.app was not found'
  }
  if (!resolveMacOSComputerUseExecutablePath()) {
    return `${helperAppPath}/Contents/MacOS/orca-computer-use-macos was not found`
  }
  return null
}

function createUnavailablePermissionStatus(
  reason: string,
  helperAppPath: string | null
): ComputerUsePermissionStatusResult {
  return {
    platform: process.platform,
    helperAppPath,
    helperUnavailableReason: reason,
    permissions: [
      { id: 'accessibility', status: 'not-granted' },
      { id: 'screenshots', status: 'not-granted' }
    ]
  }
}

async function readPermissionStatusFromHelper(
  executablePath: string,
  onHelperSpawn: () => void
): Promise<HelperPermissionStatus> {
  // A direct child, so a timeout stops this probe by PID; the helper disclaims Orca so TCC checks its own grant.
  const probe = runProcess({
    program: executablePath,
    args: ['--permission-status'],
    timeoutMs: PERMISSION_STATUS_HELPER_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  onHelperSpawn()
  const result = await probe.catch(() => {
    throw new RuntimeClientError(
      'accessibility_error',
      'Could not check permissions: failed to launch helper'
    )
  })
  if (result.timedOut) {
    throw new RuntimeClientError('accessibility_error', 'Timed out checking permissions')
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code ?? result.signal ?? 'unknown'}`
    throw new RuntimeClientError('accessibility_error', `Could not check permissions: ${detail}`)
  }
  const status: HelperPermissionStatus = JSON.parse(result.stdout)
  return status
}
