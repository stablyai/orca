import { spawn } from 'node:child_process'
import { runProcess } from '@orca/process-host'
import { RuntimeClientError } from '../runtime-client-error'
import {
  COMPUTER_ERROR_CODES,
  COMPUTER_SCREEN_LOCKED_MESSAGE
} from '../../../shared/computer-use-runtime-types'
import { isHostShuttingDown } from '../../startup/quit/host-shutdown-state'
import { readMacosBundleId, resetMacosTccPermission } from '../../macos-permissions/macos-tcc-reset'
import { resolveMacOSComputerUseAppPath } from '../macos-native/macos-native-provider-paths'
import {
  readMacOSSessionLocked,
  resolveComputerUseHelperUnavailableReason
} from './macos-computer-use-permission-status'
import { computerUsePermissionStatusGate } from './macos-computer-use-permission-status-gate'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../shared/computer-use-permissions-types'

const DEFAULT_COMPUTER_USE_BUNDLE_ID = 'com.stablyai.orca.computer-use'

// One setup-helper spawn per 5s across every permission, on the monotonic clock; claimed synchronously.
const SETUP_HELPER_LAUNCH_WINDOW_MS = 5_000
// Requests are numbered on arrival; a queued request loses to any later one (latest wins).
type SetupLaunchRequest = { seq: number; helperAppPath: string; helperArgs: string[] }
type SetupLaunchOutcome = 'launched' | 'cancelled'
let setupLaunchInFlight: { seq: number; done: Promise<SetupLaunchOutcome> } | null = null
let setupRequestSeq = 0
let lastLaunch: { seq: number; coversSeq: number; argsKey: string; at: number } | null = null
let queuedSetupLaunch: SetupLaunchRequest | null = null
let queuedSetupTimer: ReturnType<typeof setTimeout> | null = null
// Bumped by reset so Opens still waiting on status never launch afterwards.
let setupGeneration = 0
// Opens that arrive mid-reset wait for it, so reset's helper cleanup can't kill what they open.
let resetInProgress: Promise<ComputerUsePermissionResetResult> | null = null

/** `locale` comes from the desktop caller; orcad and CLI opens leave the helper on its default copy. */
export function openComputerUsePermissions(
  permissionId?: ComputerUsePermissionId,
  options: { locale?: string; skipGranted?: boolean } = {}
): Promise<ComputerUsePermissionSetupResult> {
  return openComputerUsePermissionsAsync(permissionId, options, ++setupRequestSeq, setupGeneration)
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
async function requestSetupHelperLaunch(
  request: SetupLaunchRequest
): Promise<SetupLaunchOutcome | 'queued' | 'superseded'> {
  // A newer request already spawned; showing this older one now would replace it.
  if (lastLaunch && request.seq <= lastLaunch.seq) {
    return 'superseded'
  }
  if (setupLaunchInFlight && request.seq < setupLaunchInFlight.seq) {
    return (await setupLaunchInFlight.done) === 'launched' ? 'superseded' : 'cancelled'
  }
  if (!setupLaunchInFlight && performance.now() >= setupWindowOpensAt() && !queuedSetupLaunch) {
    return startSetupHelperLaunch(request)
  }
  if (!queuedSetupLaunch || request.seq > queuedSetupLaunch.seq) {
    queuedSetupLaunch = request
  }
  armQueuedSetupTimer()
  return 'queued'
}

function armQueuedSetupTimer(): void {
  if (queuedSetupTimer || setupLaunchInFlight || !queuedSetupLaunch) {
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
        void startSetupHelperLaunch(queued).catch((error) => {
          console.error('[computer-use] queued setup helper launch failed:', error)
        })
      }
    },
    Math.max(0, Math.ceil(setupWindowOpensAt() - performance.now()))
  )
  queuedSetupTimer.unref?.()
}

function startSetupHelperLaunch(request: SetupLaunchRequest): Promise<SetupLaunchOutcome> {
  const generation = setupGeneration
  // Publish the owner before cleanup can yield to another Open or Reset.
  const launch = {
    seq: request.seq,
    done: Promise.resolve()
      .then(() => launchSetupHelper(request, generation))
      .finally(() => {
        if (setupLaunchInFlight === launch) {
          setupLaunchInFlight = null
          armQueuedSetupTimer()
        }
      })
  }
  setupLaunchInFlight = launch
  return launch.done
}

async function launchSetupHelper(
  request: SetupLaunchRequest,
  generation: number
): Promise<SetupLaunchOutcome> {
  if (isHostShuttingDown()) {
    return 'cancelled'
  }
  // Kill and relaunch so a repeated click always brings the helper back to the front.
  await closeExistingPermissionHelpers()
  if (generation !== setupGeneration || isHostShuttingDown()) {
    return 'cancelled'
  }
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
  return 'launched'
}

async function openComputerUsePermissionsAsync(
  permissionId: ComputerUsePermissionId | undefined,
  { locale, skipGranted }: { locale?: string; skipGranted?: boolean },
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
  // Why: behind the lock screen macOS reports Accessibility as untrusted, so setup would open Settings for nothing.
  // The status may be cached from before a lock, so the lock is read fresh too.
  if (status.sessionLocked || (await readMacOSSessionLocked())) {
    throw new RuntimeClientError(COMPUTER_ERROR_CODES.screen_locked, COMPUTER_SCREEN_LOCKED_MESSAGE)
  }
  const nextStep = nextPermissionStep(status.permissions)
  if (generation !== setupGeneration || isHostShuttingDown()) {
    // An error rather than launchedHelper: false, which clients render as "setup complete".
    throw new RuntimeClientError(
      'accessibility_error',
      'Computer Use setup was cancelled because permissions were reset or Orca is quitting'
    )
  }

  const alreadyGranted = permissionId
    ? skipGranted === true &&
      status.permissions.some(
        (permission) => permission.id === permissionId && permission.status === 'granted'
      )
    : !nextStep
  if (alreadyGranted) {
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
  if (locale) {
    // Why: the helper renders permission copy in the app's UI language.
    helperArgs.push('--locale', locale)
  }
  const launch = await requestSetupHelperLaunch({ seq, helperAppPath, helperArgs })
  if (launch === 'cancelled') {
    throw new RuntimeClientError(
      'accessibility_error',
      'Computer Use setup was cancelled because permissions were reset or Orca is quitting'
    )
  }

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
  // Every click cancels older Opens, including when joining an active reset.
  cancelPendingSetupLaunches()
  if (resetInProgress) {
    return resetInProgress
  }
  const reset = resetComputerUsePermissionsAsync().finally(() => {
    if (resetInProgress === reset) {
      resetInProgress = null
    }
  })
  resetInProgress = reset
  return reset
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

  const unavailableReason = resolveComputerUseHelperUnavailableReason()
  if (unavailableReason) {
    throw new RuntimeClientError('accessibility_error', unavailableReason)
  }

  const bundleId = (await readMacosBundleId(helperAppPath)) ?? DEFAULT_COMPUTER_USE_BUNDLE_ID
  await setupLaunchInFlight?.done.catch(() => {})
  await closeExistingPermissionHelpers()
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

async function closeExistingPermissionHelpers(): Promise<void> {
  // Preserve concurrent status probes when replacing permission-setup helpers.
  const setupHelperPatterns = [
    'orca-computer-use-macos[[:space:]]+--permission([[:space:]]|$)',
    'orca-computer-use-macos[[:space:]]+--permissions([[:space:]]|$)'
  ]
  for (const pattern of setupHelperPatterns) {
    // Only actual completion permits a later launch; a timeout can settle before child exit.
    await runProcess({
      program: '/usr/bin/pkill',
      args: ['-f', pattern],
      timeoutMs: null,
      stdio: 'ignore'
    }).catch(() => undefined)
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
