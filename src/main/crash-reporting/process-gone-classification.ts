export type ProcessGoneSource = 'renderer' | 'child'
export type ExpectedTeardownScope = 'none' | 'renderer-reload' | 'app-shutdown'

const WINDOWS_CONTROL_TERMINATION_EXIT_CODES = new Set([0xc000013a, 0x40010004])
const RECOVERABLE_CHILD_PROCESS_TYPES = new Set(['gpu'])
const RECOVERABLE_UTILITY_SERVICE_NAMES = new Set([
  'audio.mojom.AudioService',
  'network.mojom.NetworkService'
])
const RECOVERABLE_CHILD_PROCESS_REASONS = new Set(['abnormal-exit', 'crashed', 'killed'])

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
  source,
  processType,
  serviceName,
  reason,
  exitCode,
  expectedTeardown
}: {
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  // Why: GPU, Network Service, and Audio Service exits are recoverable Chromium
  // child-process churn; treating them as app crashes creates noisy user prompts.
  if (isRecoverableChromiumChildProcess({ source, processType, serviceName, reason })) {
    return false
  }
  // Why: Electron reports intentional reload/update/quit teardown as `killed`.
  // Real renderer OOMs and Chromium crashes should still reach crash reporting.
  if (reason !== 'killed') {
    return true
  }
  // Why: Electron reports expected Chromium teardown during reload/update as
  // `killed` + SIGTERM or Windows control termination statuses. Treat real
  // crash reasons as reportable, but skip these normal termination shapes.
  if (exitCode === 15 || isWindowsControlTerminationExitCode(exitCode)) {
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
  return !(reason === 'killed' && expectedTeardown === 'renderer-reload')
}
