import { execFileSync, spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RuntimeClientError } from './runtime-client-error'
import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from './macos-native-provider-paths'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatus,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'

const DEFAULT_COMPUTER_USE_BUNDLE_ID = 'com.stablyai.orca.computer-use'

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
  if (status.helperUnavailableReason) {
    throw new RuntimeClientError('accessibility_error', status.helperUnavailableReason)
  }
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

export function resetComputerUsePermissions(): ComputerUsePermissionResetResult {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      helperAppPath: null,
      helperUnavailableReason: null,
      bundleId: null,
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

  const status = getComputerUsePermissionStatus()
  if (status.helperUnavailableReason) {
    throw new RuntimeClientError('accessibility_error', status.helperUnavailableReason)
  }

  const bundleId = readComputerUseBundleId(helperAppPath)
  closeExistingPermissionHelpers()
  resetTccPermission('Accessibility', bundleId)
  resetTccPermission('ScreenCapture', bundleId)

  return {
    ...getComputerUsePermissionStatus(),
    bundleId
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

  const raw = readPermissionStatusFromHelperApp(helperAppPath)

  return {
    platform: process.platform,
    helperAppPath,
    helperUnavailableReason: null,
    permissions: [
      { id: 'accessibility', status: raw.accessibility ?? 'not-granted' },
      { id: 'screenshots', status: raw.screenshots ?? 'not-granted' }
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

function readPermissionStatusFromHelperApp(
  helperAppPath: string
): Partial<Record<ComputerUsePermissionId, ComputerUsePermissionStatus>> {
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-computer-use-permissions-'))
  const statusPath = join(tempDir, 'status.json')
  try {
    // Why: TCC status must be checked through the helper app identity. Directly
    // execing the binary can inherit the parent app's already-granted context.
    const launch = spawnSync(
      '/usr/bin/open',
      ['-n', helperAppPath, '--args', '--permission-status-file', statusPath],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    if (launch.status !== 0) {
      const detail =
        launch.stderr?.trim() || launch.stdout?.trim() || `exit ${launch.status ?? 'unknown'}`
      throw new RuntimeClientError('accessibility_error', `Could not check permissions: ${detail}`)
    }

    for (let attempt = 0; attempt < 50; attempt++) {
      if (existsSync(statusPath)) {
        const output = readFileSync(statusPath, 'utf8')
        return JSON.parse(output) as Partial<
          Record<ComputerUsePermissionId, ComputerUsePermissionStatus>
        >
      }
      spawnSync('/bin/sleep', ['0.1'], { stdio: 'ignore' })
    }
    throw new RuntimeClientError('accessibility_error', 'Timed out checking permissions')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function readComputerUseBundleId(helperAppPath: string): string {
  const infoPlistPath = join(helperAppPath, 'Contents', 'Info.plist')
  try {
    const bundleId = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', infoPlistPath],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    ).trim()
    return bundleId || DEFAULT_COMPUTER_USE_BUNDLE_ID
  } catch {
    return DEFAULT_COMPUTER_USE_BUNDLE_ID
  }
}

function resetTccPermission(service: string, bundleId: string): void {
  // Why: macOS keeps TCC rows after uninstall; users need an explicit way to
  // clear stale grants or denials for the helper's stable bundle identity.
  const result = spawnSync('/usr/bin/tccutil', ['reset', service, bundleId], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status === 0) {
    return
  }
  const detail =
    result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status ?? 'unknown'}`
  throw new RuntimeClientError('accessibility_error', `Could not reset ${service}: ${detail}`)
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
