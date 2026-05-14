import { execFileSync, spawn, spawnSync } from 'child_process'
import { RuntimeClientError } from './runtime-client-error'
import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from './macos-native-provider-paths'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatus,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'

export function openComputerUsePermissions(
  permissionId?: ComputerUsePermissionId
): ComputerUsePermissionSetupResult {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      helperAppPath: null,
      permissionId,
      openedSettings: false,
      launchedHelper: false,
      permissions: [
        { id: 'accessibility', status: 'unsupported' },
        { id: 'screenshots', status: 'unsupported' }
      ],
      nextStep: null
    }
  }

  const helperAppPath = resolveMacOSComputerUseAppPath()
  if (!helperAppPath) {
    throw new RuntimeClientError('accessibility_error', 'Orca Computer Use.app was not found')
  }
  const status = getComputerUsePermissionStatus()
  const nextStep = nextPermissionStep(status.permissions)

  if (!permissionId && !nextStep) {
    return {
      platform: process.platform,
      helperAppPath,
      permissionId,
      openedSettings: false,
      launchedHelper: false,
      permissions: status.permissions,
      nextStep
    }
  }

  closeExistingPermissionHelpers()
  const helperArgs = permissionId ? ['--permission', permissionId] : ['--permissions']
  const helper = spawn('/usr/bin/open', ['-n', helperAppPath, '--args', ...helperArgs], {
    detached: true,
    stdio: 'ignore'
  })
  helper.unref()

  return {
    platform: process.platform,
    helperAppPath,
    permissionId,
    openedSettings: permissionId !== undefined,
    launchedHelper: true,
    permissions: status.permissions,
    nextStep
  }
}

function closeExistingPermissionHelpers(): void {
  spawnSync('/usr/bin/pkill', ['-f', 'orca-computer-use-macos --permission'], {
    stdio: 'ignore'
  })
  spawnSync('/usr/bin/pkill', ['-f', 'orca-computer-use-macos --permissions'], {
    stdio: 'ignore'
  })
}

export function getComputerUsePermissionStatus(): ComputerUsePermissionStatusResult {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      permissions: [
        { id: 'accessibility', status: 'unsupported' },
        { id: 'screenshots', status: 'unsupported' }
      ]
    }
  }

  const helperAppPath = resolveMacOSComputerUseAppPath()
  if (!helperAppPath) {
    throw new RuntimeClientError('accessibility_error', 'Orca Computer Use.app was not found')
  }

  const raw = readPermissionStatusFromHelperApp(helperAppPath)

  return {
    platform: process.platform,
    permissions: [
      { id: 'accessibility', status: raw.accessibility ?? 'not-granted' },
      { id: 'screenshots', status: raw.screenshots ?? 'not-granted' }
    ]
  }
}

function readPermissionStatusFromHelperApp(
  helperAppPath: string
): Partial<Record<ComputerUsePermissionId, ComputerUsePermissionStatus>> {
  const executablePath = resolveMacOSComputerUseExecutablePath()
  if (!executablePath) {
    throw new RuntimeClientError(
      'accessibility_error',
      `${helperAppPath}/Contents/MacOS/orca-computer-use-macos was not found`
    )
  }
  // Why: launching the nested helper via LaunchServices can make TCC evaluate
  // Orca.app as responsible; the signed helper executable owns this grant.
  const output = execFileSync(executablePath, ['--permission-status'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return JSON.parse(output) as Partial<Record<ComputerUsePermissionId, ComputerUsePermissionStatus>>
}

function nextPermissionStep(
  permissions: ComputerUsePermissionStatusResult['permissions']
): string | null {
  const missing = permissions.find((permission) => permission.status !== 'granted')
  if (!missing) {
    return null
  }
  return `Grant ${missing.id === 'accessibility' ? 'Accessibility' : 'Screen Recording'} to Orca Computer Use, then retry get-app-state.`
}
