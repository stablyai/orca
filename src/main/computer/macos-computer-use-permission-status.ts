import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'
import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from './macos-native-provider-paths'
import { callComputerSidecarPermissionStatus } from './sidecar-client'

export function getComputerUsePermissionStatus(): Promise<ComputerUsePermissionStatusResult> {
  return getComputerUsePermissionStatusAsync()
}

async function getComputerUsePermissionStatusAsync(): Promise<ComputerUsePermissionStatusResult> {
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
  if (!helperAppPath) {
    return createUnavailablePermissionStatus('Orca Computer Use.app was not found', null)
  }

  const executablePath = resolveMacOSComputerUseExecutablePath()
  if (!executablePath) {
    return createUnavailablePermissionStatus(
      `${helperAppPath}/Contents/MacOS/orca-computer-use-macos was not found`,
      helperAppPath
    )
  }

  const raw = await callComputerSidecarPermissionStatus()

  return {
    platform: process.platform,
    helperAppPath,
    helperUnavailableReason: null,
    permissions: [
      { id: 'accessibility', status: raw.accessibility },
      { id: 'screenshots', status: raw.screenshots }
    ]
  }
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
