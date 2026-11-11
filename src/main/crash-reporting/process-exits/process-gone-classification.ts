import { STT_UTILITY_PROCESS_NAME } from '../../speech/stt-worker-process'

export type ProcessGoneSource = 'renderer' | 'child'
export type ExpectedTeardownScope = 'none' | 'renderer-reload' | 'app-shutdown'

const WINDOWS_CONTROL_TERMINATION_EXIT_CODES = new Set([0xc000013a, 0x40010004])
// Chromium's PID-namespace SIGTERM handler exits 241; waitpid reports 241 << 8.
const LINUX_NAMESPACE_SIGTERM_WAIT_STATUS = 0xf100
const RECOVERABLE_CHILD_PROCESS_TYPES = new Set(['gpu'])
const RECOVERABLE_UTILITY_SERVICE_NAMES = new Set([
  'audio.mojom.AudioService',
  'network.mojom.NetworkService',
  // Screen-capture service exits are recoverable Chromium churn.
  'video_capture.mojom.VideoCaptureService'
])
// Orca's own utility processes whose exits the app already handles and reports in place.
const RECOVERABLE_ORCA_UTILITY_NAMES = new Set([STT_UTILITY_PROCESS_NAME])
const RECOVERABLE_CHILD_PROCESS_REASONS = new Set(['abnormal-exit', 'crashed', 'killed'])
const NON_RECOVERABLE_RENDERER_REASONS = new Set(['integrity-failure'])

/** Electron's child-process-gone names: a utility's mojo service, and its fork serviceName. */
export function childProcessNames(details: Record<string, unknown>): {
  serviceName?: string
  name?: string
} {
  return {
    serviceName: typeof details.serviceName === 'string' ? details.serviceName : undefined,
    name: typeof details.name === 'string' ? details.name : undefined
  }
}

function isWindowsControlTerminationExitCode(exitCode: number | null): boolean {
  if (exitCode === null) {
    return false
  }
  return WINDOWS_CONTROL_TERMINATION_EXIT_CODES.has(exitCode >>> 0)
}

function isRecoverableChildProcess({
  source,
  processType,
  serviceName,
  name,
  reason
}: {
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  name?: string
  reason: string
}): boolean {
  if (source !== 'child') {
    return false
  }
  const normalizedProcessType = processType?.toLowerCase()
  // Orca handles every exit of its own utilities, including OOM and failed launches.
  if (
    normalizedProcessType === 'utility' &&
    name !== undefined &&
    RECOVERABLE_ORCA_UTILITY_NAMES.has(name)
  ) {
    return true
  }
  if (!RECOVERABLE_CHILD_PROCESS_REASONS.has(reason)) {
    return false
  }
  if (normalizedProcessType && RECOVERABLE_CHILD_PROCESS_TYPES.has(normalizedProcessType)) {
    return true
  }
  return (
    normalizedProcessType === 'utility' &&
    serviceName !== undefined &&
    RECOVERABLE_UTILITY_SERVICE_NAMES.has(serviceName)
  )
}

export function shouldRecordProcessGoneCrash({
  platform,
  source,
  processType,
  serviceName,
  name,
  reason,
  exitCode,
  expectedTeardown
}: {
  platform: NodeJS.Platform
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  name?: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  if (isRecoverableChildProcess({ source, processType, serviceName, name, reason })) {
    return false
  }
  // Intentional teardown uses killed; explicit crash and OOM reasons remain reportable.
  if (reason !== 'killed') {
    return true
  }
  // Ignore normal termination signals even when no teardown scope was recorded.
  if (
    exitCode === 15 ||
    isWindowsControlTerminationExitCode(exitCode) ||
    (platform === 'linux' && exitCode === LINUX_NAMESPACE_SIGTERM_WAIT_STATUS)
  ) {
    return false
  }
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  return !(source === 'renderer' && expectedTeardown === 'renderer-reload')
}

export function shouldRecoverRendererAfterProcessGone({
  reason,
  expectedTeardown
}: {
  reason: string
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  // Integrity failures cannot safely reload; callers bound retries for transient launch failures.
  if (NON_RECOVERABLE_RENDERER_REASONS.has(reason)) {
    return false
  }
  return !(reason === 'killed' && expectedTeardown === 'renderer-reload')
}
