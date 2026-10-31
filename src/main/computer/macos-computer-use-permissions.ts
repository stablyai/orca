import { spawn, spawnSync } from 'node:child_process'
import { RuntimeClientError } from './runtime-client-error'
import { isHostShuttingDown } from '../host-shutdown-state'
import { readMacosBundleId, resetMacosTccPermission } from '../macos-tcc-reset'
import { resolveMacOSComputerUseAppPath } from './macos-native-provider-paths'
import { resolveComputerUseHelperUnavailableReason } from './macos-computer-use-permission-status'
import { computerUsePermissionStatusGate } from './macos-computer-use-permission-status-gate'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'

const DEFAULT_COMPUTER_USE_BUNDLE_ID = 'com.stablyai.orca.computer-use'

export { getComputerUsePermissionStatus } from './macos-computer-use-permission-status'

// One setup-helper spawn per 5s across every permission, on the monotonic clock; claimed synchronously.
const SETUP_HELPER_LAUNCH_WINDOW_MS = 5_000
// Requests are numbered on arrival; a queued request loses to any later one (latest wins).
type SetupLaunchRequest = { seq: number; helperAppPath: string; helperArgs: string[] }
let setupRequestSeq = 0
let lastLaunch: { seq: number; coversSeq: number; argsKey: string; at: number } | null = null
let queuedSetupLaunch: SetupLaunchRequest | null = null
let queuedSetupTimer: ReturnType<typeof setTimeout> | null = null
// Bumped by reset so Opens still waiting on status never launch afterwards.
let setupGeneration = 0
// Opens that arrive mid-reset wait for it, so reset's helper cleanup can't kill what they open.
let resetInProgress: Promise<unknown> | null = null

export function openComputerUsePermissions(
  permissionId?: ComputerUsePermissionId
): Promise<ComputerUsePermissionSetupResult> {
  return openComputerUsePermissionsAsync(permissionId, ++setupRequestSeq, setupGeneration)
}

function cancelPendingSetupLaunches(): void {
  setupGeneration += 1
  if (queuedSetupTimer) {
    clearTimeout(queuedSetupTimer)
    queuedSetupTimer = null
  }
  queuedSetupLaunch = null
}

const setupWindowOpensAt = (): number =>
  (lastLaunch?.at ?? Number.NEGATIVE_INFINITY) + SETUP_HELPER_LAUNCH_WINDOW_MS

// Launches now, or queues for when the window reopens; a later request supersedes a queued one.
function requestSetupHelperLaunch(
  request: SetupLaunchRequest
): 'launched' | 'queued' | 'superseded' {
  // A newer request already spawned; showing this older one now would replace it.
  if (lastLaunch && request.seq <= lastLaunch.seq) {
    return 'superseded'
  }
  if (performance.now() >= setupWindowOpensAt() && !queuedSetupLaunch) {
    launchSetupHelper(request)
    return 'launched'
  }
  if (!queuedSetupLaunch || request.seq > queuedSetupLaunch.seq) {
    queuedSetupLaunch = request
  }
  armQueuedSetupTimer()
  return 'queued'
}

function armQueuedSetupTimer(): void {
  if (queuedSetupTimer) {
    return
  }
  queuedSetupTimer = setTimeout(
    () => {
      queuedSetupTimer = null
      // Timers can fire a fraction early; never spawn inside the window.
      if (performance.now() < setupWindowOpensAt()) {
        armQueuedSetupTimer()
        return
      }
      const queued = queuedSetupLaunch
      queuedSetupLaunch = null
      // Same-args requests that arrived before the last spawn were already shown by it.
      const covered =
        queued &&
        lastLaunch &&
        (queued.seq <= lastLaunch.seq ||
          (lastLaunch.argsKey === queued.helperArgs.join(' ') &&
            queued.seq <= lastLaunch.coversSeq))
      if (queued && !covered) {
        try {
          launchSetupHelper(queued)
        } catch (error) {
          console.error('[computer-use] queued setup helper launch failed:', error)
        }
      }
    },
    Math.max(0, Math.ceil(setupWindowOpensAt() - performance.now()))
  )
  queuedSetupTimer.unref?.()
}

function launchSetupHelper(request: SetupLaunchRequest): void {
  if (isHostShuttingDown()) {
    return
  }
  // Kill and relaunch so a repeated click always brings the helper back to the front.
  closeExistingPermissionHelpers()
  const helper = spawn(
    '/usr/bin/open',
    ['-n', request.helperAppPath, '--args', ...request.helperArgs],
    { detached: true, stdio: 'ignore' }
  )
  // Measured after the spawn so a slow pkill can't pull the next spawn inside the window.
  lastLaunch = {
    seq: request.seq,
    coversSeq: setupRequestSeq,
    argsKey: request.helperArgs.join(' '),
    at: performance.now()
  }
  helper.unref()
}

async function openComputerUsePermissionsAsync(
  permissionId: ComputerUsePermissionId | undefined,
  seq: number,
  generation: number
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
  // Wait out a reset before reading status, so this Open never sees pre-reset grants.
  while (resetInProgress) {
    await resetInProgress.catch(() => {})
  }
  const status = await computerUsePermissionStatusGate.peek()
  if (status.helperUnavailableReason) {
    throw new RuntimeClientError('accessibility_error', status.helperUnavailableReason)
  }
  const nextStep = nextPermissionStep(status.permissions)
  if (generation !== setupGeneration || isHostShuttingDown()) {
    // An error rather than launchedHelper: false, which clients render as "setup complete".
    throw new RuntimeClientError(
      'accessibility_error',
      'Computer Use setup was cancelled because permissions were reset or Orca is quitting'
    )
  }

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
  const helperArgs = permissionId ? ['--permission', permissionId] : ['--permissions']
  const launch = requestSetupHelperLaunch({ seq, helperAppPath, helperArgs })

  return {
    platform: process.platform,
    helperAppPath,
    permissionId,
    openedSettings: launch === 'launched' && permissionId !== undefined,
    // Also true when superseded: a newer request's helper is already showing.
    launchedHelper: true,
    launchQueued: launch === 'queued',
    permissions: status.permissions,
    nextStep
  }
}

export function resetComputerUsePermissions(): Promise<ComputerUsePermissionResetResult> {
  const reset = resetComputerUsePermissionsAsync().finally(() => {
    if (resetInProgress === reset) {
      resetInProgress = null
    }
  })
  resetInProgress = reset
  return reset
}

async function resetComputerUsePermissionsAsync(): Promise<ComputerUsePermissionResetResult> {
  // Before any await, so a queued or preflighting Open can't slip a helper in during the reset.
  cancelPendingSetupLaunches()
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

  const unavailableReason = resolveComputerUseHelperUnavailableReason()
  if (unavailableReason) {
    throw new RuntimeClientError('accessibility_error', unavailableReason)
  }

  const bundleId = (await readMacosBundleId(helperAppPath)) ?? DEFAULT_COMPUTER_USE_BUNDLE_ID
  closeExistingPermissionHelpers()
  try {
    await resetTccPermission('Accessibility', bundleId)
    await resetTccPermission('ScreenCapture', bundleId)
  } finally {
    // Even a partial reset may have revoked grants; never serve the pre-reset snapshot again.
    computerUsePermissionStatusGate.invalidate()
  }

  return {
    ...(await computerUsePermissionStatusGate.read()),
    bundleId
  }
}

function closeExistingPermissionHelpers(): void {
  // Preserve concurrent status probes when replacing permission-setup helpers.
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

async function resetTccPermission(service: string, bundleId: string): Promise<void> {
  // TCC grants survive uninstall; explicitly reset the helper's stable bundle identity.
  const result = await resetMacosTccPermission(service, bundleId)
  if (!result.ok) {
    throw new RuntimeClientError(
      'accessibility_error',
      `Could not reset ${service}: ${result.detail}`
    )
  }
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
