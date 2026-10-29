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
const RECOVERABLE_CHILD_PROCESS_REASONS = new Set(['abnormal-exit', 'crashed', 'killed'])
const NON_RECOVERABLE_RENDERER_REASONS = new Set(['integrity-failure'])

function isWindowsControlTerminationExitCode(exitCode: number | null): boolean {
  if (exitCode === null) {
    return false
  }
  return WINDOWS_CONTROL_TERMINATION_EXIT_CODES.has(exitCode >>> 0)
}

function isRecoverableChromiumChildProcess({
  source,
  processType,
  serviceName,
  reason
}: {
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  reason: string
}): boolean {
  if (source !== 'child') {
    return false
  }
  if (!RECOVERABLE_CHILD_PROCESS_REASONS.has(reason)) {
    return false
  }
  const normalizedProcessType = processType?.toLowerCase()
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
  reason,
  exitCode,
  expectedTeardown
}: {
  platform: NodeJS.Platform
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  if (isRecoverableChromiumChildProcess({ source, processType, serviceName, reason })) {
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
