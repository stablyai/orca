import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'
import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from './macos-native-provider-paths'
import * as permissionStatusWire from './macos-native-provider-permission-status'
import { isMacOS14OrNewer } from './macos-native-provider-transport'
import { callComputerSidecarPermissionStatus } from './sidecar-client'

let inFlightStatusRead: Promise<ComputerUsePermissionStatusResult> | null = null

// Why single-flight: every window focus can reach here from several renderer consumers at once.
export function getComputerUsePermissionStatus(): Promise<ComputerUsePermissionStatusResult> {
  return inFlightStatusRead ?? trackStatusRead(readComputerUsePermissionStatus(false))
}

// Why: a read that started before a TCC reset must not answer for the state after it.
export function getFreshComputerUsePermissionStatus(): Promise<ComputerUsePermissionStatusResult> {
  return trackStatusRead(readComputerUsePermissionStatus(true))
}

function trackStatusRead(
  read: Promise<ComputerUsePermissionStatusResult>
): Promise<ComputerUsePermissionStatusResult> {
  inFlightStatusRead = read
  const clear = (): void => {
    if (inFlightStatusRead === read) {
      inFlightStatusRead = null
    }
  }
  read.then(clear, clear)
  return read
}

async function readComputerUsePermissionStatus(
  fresh: boolean
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

  if (!isMacOS14OrNewer()) {
    return createUnavailablePermissionStatus(
      'Orca Computer Use requires macOS 14 or newer',
      helperAppPath
    )
  }

  let raw: unknown
  try {
    // Why the provider: it is spawned directly (no LaunchServices) and its own grants are what actions use.
    raw = await callComputerSidecarPermissionStatus(fresh)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'unsupported_capability') {
      return createUnavailablePermissionStatus(
        `Orca Computer Use cannot report permissions: ${error.message}`,
        helperAppPath
      )
    }
    throw error
  }
  const status = permissionStatusWire.parse(raw)
  return {
    platform: process.platform,
    helperAppPath,
    helperUnavailableReason: null,
    permissions: [
      { id: 'accessibility', status: status.accessibility },
      { id: 'screenshots', status: status.screenshots }
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
