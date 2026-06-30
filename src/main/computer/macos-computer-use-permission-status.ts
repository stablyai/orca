import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionStatus,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'
import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from './macos-native-provider-paths'
import { RuntimeClientError } from './runtime-client-error'

const PERMISSION_STATUS_HELPER_LAUNCH_TIMEOUT_MS = 5_000

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
