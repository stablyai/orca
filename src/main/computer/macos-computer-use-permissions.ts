import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { RuntimeClientError } from './runtime-client-error'
import { resolveMacOSComputerUseAppPath } from './macos-native-provider-paths'
import { getComputerUsePermissionStatus } from './macos-computer-use-permission-status'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'

const DEFAULT_COMPUTER_USE_BUNDLE_ID = 'com.stablyai.orca.computer-use'

export { getComputerUsePermissionStatus } from './macos-computer-use-permission-status'

export function openComputerUsePermissions(
  permissionId?: ComputerUsePermissionId
): Promise<ComputerUsePermissionSetupResult> {
  return openComputerUsePermissionsAsync(permissionId)
}

async function openComputerUsePermissionsAsync(
  permissionId?: ComputerUsePermissionId
): Promise<ComputerUsePermissionSetupResult> {
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
  const status = await getComputerUsePermissionStatus()
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

export function resetComputerUsePermissions(): Promise<ComputerUsePermissionResetResult> {
  return resetComputerUsePermissionsAsync()
}

async function resetComputerUsePermissionsAsync(): Promise<ComputerUsePermissionResetResult> {
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

  const status = await getComputerUsePermissionStatus()
  if (status.helperUnavailableReason) {
    throw new RuntimeClientError('accessibility_error', status.helperUnavailableReason)
  }

  const bundleId = readComputerUseBundleId(helperAppPath)
  closeExistingPermissionHelpers()
  resetTccPermission('Accessibility', bundleId)
  resetTccPermission('ScreenCapture', bundleId)

  return {
    ...(await getComputerUsePermissionStatus()),
    bundleId
  }
}

function closeExistingPermissionHelpers(): void {
  // Why: status probes use --permission-status-file and must not be killed
  // while setup helpers are being replaced.
  const setupHelperPatterns = [
    'orca-computer-use-macos[[:space:]]+--permission([[:space:]]|$)',
    'orca-computer-use-macos[[:space:]]+--permissions([[:space:]]|$)'
  ]
  for (const pattern of setupHelperPatterns) {
    spawnSync('/usr/bin/pkill', ['-f', pattern], {
      stdio: 'ignore'
    })
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
