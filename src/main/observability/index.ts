// Keep diagnostics isolated from product telemetry, including duplicated CI detection.
// DNT/ORCA_TELEMETRY_DISABLED disable uploads but retain local logs;
// ORCA_DIAGNOSTICS_DISABLED and CI disable both.

import {
  createLocalFileSink,
  DEFAULT_MAX_FILES,
  getRotatedFamilySize,
  type LocalFileSink
} from './local-file-sink'
import { getDaemonLogFilePath, getTraceFilePath } from './logs-directory'
import { DAEMON_LOG_MAX_FILES } from '../daemon/daemon-file-log'
import {
  collectBundle as _collectBundle,
  type CollectBundleOptions,
  type CollectedBundle
} from './bundle'
import {
  deleteBundle as _deleteBundle,
  uploadBundle as _uploadBundle,
  type DeleteBundleOptions,
  type UploadBundleOptions,
  type UploadBundleResult
} from './diagnostic-bundle-upload'
import { setActiveSink, startSpan } from './tracer'
import { setSecurePathHardeningReporter } from '../../shared/secure-path-hardening-report'

const CI_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
] as const

export type ObservabilityConsent = {
  readonly localFileEnabled: boolean
  readonly bundleEnabled: boolean
  readonly disabledReason?:
    | 'do_not_track'
    | 'orca_telemetry_disabled'
    | 'orca_diagnostics_disabled'
    | 'ci'
}

function envOn(name: string): boolean {
  const v = process.env[name]
  if (!v) {
    return false
  }
  const norm = v.trim().toLowerCase()
  return norm === '1' || norm === 'true'
}

function inCI(): boolean {
  return CI_ENV_VARS.some((v) => process.env[v] !== undefined && process.env[v] !== '')
}

export function resolveObservabilityConsent(): ObservabilityConsent {
  const dnt = envOn('DO_NOT_TRACK')
  const orcaDisabled = envOn('ORCA_TELEMETRY_DISABLED')
  const diagnosticsDisabled = envOn('ORCA_DIAGNOSTICS_DISABLED')
  const ci = inCI()

  if (ci) {
    return {
      localFileEnabled: false,
      bundleEnabled: false,
      disabledReason: 'ci'
    }
  }
  if (diagnosticsDisabled) {
    return {
      localFileEnabled: false,
      bundleEnabled: false,
      disabledReason: 'orca_diagnostics_disabled'
    }
  }
  if (dnt || orcaDisabled) {
    // DNT gates network traffic; local files remain on this machine.
    return {
      localFileEnabled: true,
      bundleEnabled: false,
      disabledReason: dnt ? 'do_not_track' : 'orca_telemetry_disabled'
    }
  }

  return {
    localFileEnabled: true,
    bundleEnabled: true
  }
}

export { getTraceFilePath } from './logs-directory'

let sink: LocalFileSink | null = null
let consent: ObservabilityConsent | null = null

function installLocalSink(filePath: string): void {
  try {
    const localSink = createLocalFileSink({ filePath })
    sink = localSink
    setActiveSink(localSink)
  } catch (error) {
    // Optional diagnostics must not prevent app or host startup.
    console.warn(`[observability] tracing is off: cannot open ${filePath}`, error)
  }
}

/** Override for another process’s trace; desktop traces remain the bundle default. */
export function initObservability(options?: { traceFilePath?: string }): ObservabilityConsent {
  const c = resolveObservabilityConsent()
  consent = c
  if (!c.localFileEnabled) {
    return c
  }
  installLocalSink(options?.traceFilePath ?? getTraceFilePath())
  installSecurePathHardeningReporter()
  return c
}

// Windows GUI builds have no console, so trace ACL hardening failures here.
// Record recovery too, so diagnostics show both entering and leaving degraded state.
function installSecurePathHardeningReporter(): void {
  setSecurePathHardeningReporter((entry) => {
    const span = startSpan('secure-path.windows-acl', {
      attributes: { targetPath: entry.targetPath, stage: entry.stage, detail: entry.detail }
    })
    if (entry.stage === 'recovered') {
      span.end()
      console.info('[secure-path.windows-acl] path hardening recovered', entry)
      return
    }
    span.fail(entry.detail)
    console.warn('[secure-path.windows-acl] failed to restrict path', entry)
  })
}

/** Flush for exits that bypass shutdown. */
export function flushObservability(): void {
  try {
    sink?.flush()
  } catch {
    // Nothing is left to report to.
  }
}

export async function shutdownObservability(): Promise<void> {
  setSecurePathHardeningReporter(null)
  // Stop new tracer writes before closing and flushing the sink.
  setActiveSink(null)
  if (sink) {
    sink.close()
    sink = null
  }
  consent = null
}

export type DiagnosticsStatus = {
  readonly localFileEnabled: boolean
  readonly bundleEnabled: boolean
  readonly traceFilePath: string
  readonly traceFamilySize: number
  readonly disabledReason?: ObservabilityConsent['disabledReason']
}

export function getDiagnosticsStatus(): DiagnosticsStatus {
  const c = consent ?? resolveObservabilityConsent()
  const traceFilePath = getTraceFilePath()
  const traceFamilySize = c.localFileEnabled ? getRotatedFamilySize(traceFilePath) : 0
  return {
    localFileEnabled: c.localFileEnabled,
    bundleEnabled: c.bundleEnabled,
    traceFilePath,
    traceFamilySize,
    ...(c.disabledReason ? { disabledReason: c.disabledReason } : {})
  }
}

/** Never include install_id: bundles use independent submission IDs. */
export function collectDiagnosticBundle(
  meta: Pick<
    CollectBundleOptions,
    'appVersion' | 'platform' | 'arch' | 'osRelease' | 'orcaChannel' | 'lookbackMinutes'
  >
): CollectedBundle {
  // Flush before collection so the bundle includes the user’s latest action.
  if (sink) {
    sink.flush()
  }
  return _collectBundle({
    traceFilePath: getTraceFilePath(),
    maxFiles: DEFAULT_MAX_FILES,
    // The daemon writes a separate file; collection does not glob the directory.
    daemonLogFilePath: getDaemonLogFilePath(),
    daemonLogMaxFiles: DAEMON_LOG_MAX_FILES,
    ...meta
  })
}

export async function uploadDiagnosticBundle(
  opts: UploadBundleOptions
): Promise<UploadBundleResult> {
  return _uploadBundle(opts)
}

export async function deleteDiagnosticBundle(opts: DeleteBundleOptions): Promise<void> {
  return _deleteBundle(opts)
}
