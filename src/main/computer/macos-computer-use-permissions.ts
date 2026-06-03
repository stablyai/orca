/* oxlint-disable max-lines -- Why: permission setup, status probes, and TCC
reset share the helper-app identity contract and platform guards. */
import { execFileSync, spawn, spawnSync } from 'child_process'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setTimeout as delay } from 'timers/promises'
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
const PERMISSION_STATUS_HELPER_LAUNCH_TIMEOUT_MS = 5_000

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

  const raw = await readPermissionStatusFromHelperApp(helperAppPath)

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

async function readPermissionStatusFromHelperApp(
  helperAppPath: string
): Promise<Partial<Record<ComputerUsePermissionId, ComputerUsePermissionStatus>>> {
  const tempDir = await mkdtemp(join(tmpdir(), 'orca-computer-use-permissions-'))
  const statusPath = join(tempDir, 'status.json')
  try {
    // Why: TCC status must be checked through the helper app identity. Directly
    // execing the binary can inherit the parent app's already-granted context.
    await launchPermissionStatusHelper(helperAppPath, statusPath)

    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fileExists(statusPath)) {
        const output = await readFile(statusPath, 'utf8')
        return JSON.parse(output) as Partial<
          Record<ComputerUsePermissionId, ComputerUsePermissionStatus>
        >
      }
      await delay(100)
    }
    throw new RuntimeClientError('accessibility_error', 'Timed out checking permissions')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function launchPermissionStatusHelper(helperAppPath: string, statusPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const launch = spawn(
      '/usr/bin/open',
      ['-n', helperAppPath, '--args', '--permission-status-file', statusPath],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''

    launch.stdout?.setEncoding('utf8')
    launch.stderr?.setEncoding('utf8')
    const onStdoutData = (chunk: string): void => {
      stdout += chunk
    }
    const onStderrData = (chunk: string): void => {
      stderr += chunk
    }
    let settled = false
    let launchTimeout: ReturnType<typeof setTimeout> | null = null
    const removeListeners = (): void => {
      launch.stdout?.off('data', onStdoutData)
      launch.stderr?.off('data', onStderrData)
      launch.off('error', onError)
      launch.off('close', onClose)
      if (launchTimeout) {
        clearTimeout(launchTimeout)
        launchTimeout = null
      }
    }
    const settleResolve = (): void => {
      if (settled) {
        return
      }
      settled = true
      removeListeners()
      resolve()
    }
    const settleReject = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      removeListeners()
      reject(error)
    }
    const onError = (): void => {
      settleReject(
        new RuntimeClientError(
          'accessibility_error',
          'Could not check permissions: failed to launch helper'
        )
      )
    }
    const onClose = (status: number | null): void => {
      if (status === 0) {
        settleResolve()
        return
      }
      const detail = stderr.trim() || stdout.trim() || `exit ${status ?? 'unknown'}`
      settleReject(
        new RuntimeClientError('accessibility_error', `Could not check permissions: ${detail}`)
      )
    }
    const onTimeout = (): void => {
      launch.kill()
      settleReject(
        new RuntimeClientError('accessibility_error', 'Timed out launching permission helper')
      )
    }
    // Why: the status-file polling timeout only starts after `open` exits; if
    // `open` wedges first, permission checks would otherwise stay pending.
    launchTimeout = setTimeout(onTimeout, PERMISSION_STATUS_HELPER_LAUNCH_TIMEOUT_MS)
    if (typeof launchTimeout.unref === 'function') {
      launchTimeout.unref()
    }
    launch.stdout?.on('data', onStdoutData)
    launch.stderr?.on('data', onStderrData)
    launch.on('error', onError)
    launch.on('close', onClose)
  })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
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
