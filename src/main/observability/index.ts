// Composition root for the error-tracking lane (telemetry-error-tracking.md
// §Architecture). Wires the local NDJSON sink into the active tracer, and
// exposes a single init/shutdown pair the main process calls from
// `src/main/index.ts`.
//
// Architectural rule (load-bearing): nothing in `src/main/telemetry/`
// imports from this directory and vice versa — the two lanes never share a
// code path. Cross-contamination is the failure mode this entire lane is
// counter-designed against. An import-restricted-paths lint rule will
// enforce this; even before the rule lands, the rule is a code-review
// invariant.
//
// Consent boundaries (telemetry-error-tracking.md §Consent boundaries):
//
//   DO_NOT_TRACK=1            → disable bundle button. KEEP local file.
//                                Local file writes never leave the machine,
//                                so they are not "tracking" in the DNT sense.
//   ORCA_TELEMETRY_DISABLED=1 → identical to DO_NOT_TRACK for this lane.
//   ORCA_DIAGNOSTICS_DISABLED=1 → ALSO disable local file writes. The escape
//                                hatch for users on devices where even local
//                                debug logs are policy-forbidden.
//   CI detection              → disable everything in this lane.
//
// The CI gate matches the same env-var list the product-telemetry consent
// resolver uses (CI / GITHUB_ACTIONS / GITLAB_CI / CIRCLECI / TRAVIS /
// BUILDKITE / JENKINS_URL / TEAMCITY_VERSION). Duplicating the list — rather
// than importing it from `src/main/telemetry/consent.ts` — preserves the
// import isolation rule above. The cost of one duplicated array vs.
// punching a hole in the architecture is trivially worth it.

import { app } from 'electron'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import {
  createLocalFileSink,
  DEFAULT_MAX_FILES,
  getRotatedFamilySize,
  type LocalFileSink
} from './local-file-sink'
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
import { setActiveSink } from './tracer'

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
  /** Whether the local NDJSON sink is active. */
  readonly localFileEnabled: boolean
  /** Whether the diagnostic-bundle button should be available. */
  readonly bundleEnabled: boolean
  /** Reason any of the lanes are disabled, for debug surfaces. */
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

/** Resolve the per-launch consent state for this lane. Pure — reads only
 *  process.env, so callers can re-evaluate any time without holding state. */
export function resolveObservabilityConsent(): ObservabilityConsent {
  // CI and DNT/disabled have different effects on which sub-lanes are gated.
  // Keep the ordering aligned with §Consent boundaries above.
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
    // Local file remains active — DNT is a *network* signal, and the local
    // file never leaves the machine.
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

/** Path for the trace NDJSON file. macOS conventional location is
 *  `~/Library/Application Support/Orca/logs/main.trace.ndjson`; we resolve
 *  the same intent on Windows / Linux via Electron's `userData` dir. The
 *  function falls back to homedir when Electron is not available (tests).
 */
export function getTraceFilePath(): string {
  let userData: string
  try {
    userData = app.getPath('userData')
  } catch {
    // Tests — Electron's `app` may not be initialized. Use a sensible
    // OS-conventional fallback so unit tests can construct the path
    // without spinning up the full Electron runtime.
    const home = homedir()
    if (platform() === 'darwin') {
      userData = join(home, 'Library', 'Application Support', 'Orca')
    } else if (platform() === 'win32') {
      userData = join(process.env.APPDATA ?? home, 'Orca')
    } else {
      userData = join(home, '.config', 'Orca')
    }
  }
  return join(userData, 'logs', 'main.trace.ndjson')
}

// ── Module-level state ───────────────────────────────────────────────────

let sink: LocalFileSink | null = null
let consent: ObservabilityConsent | null = null

/** Create the local file sink, install it as the active tracer sink, and
 *  update module-level `sink`. */
function installLocalSink(): void {
  const localSink = createLocalFileSink({ filePath: getTraceFilePath() })
  sink = localSink
  setActiveSink(localSink)
}

export function initObservability(): ObservabilityConsent {
  const c = resolveObservabilityConsent()
  consent = c
  if (!c.localFileEnabled) {
    // Disabled at the CI / ORCA_DIAGNOSTICS_DISABLED level — leave the
    // tracer's active sink unset, so all spans are no-ops.
    return c
  }
  installLocalSink()
  return c
}

export async function shutdownObservability(): Promise<void> {
  // Order matters: tracer first so no new pushes arrive while the local sink
  // is closing and flushing buffered lines.
  setActiveSink(null)
  if (sink) {
    sink.close()
    sink = null
  }
  consent = null
}

export function getObservabilityConsent(): ObservabilityConsent | null {
  return consent
}

// ── Bundle / trace-folder operations exposed to IPC ─────────────────────

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

/** Collect a bundle from the live trace folder. The `appVersion` /
 *  `platform` / `arch` / `osRelease` / `orcaChannel` inputs come from main
 *  and are baked into the bundle header. NEVER pass `install_id` here —
 *  the bundle's identity is the per-bundle submission ID, not the
 *  PostHog-lane install_id (Issue 8 in the security review). */
export function collectDiagnosticBundle(
  meta: Pick<
    CollectBundleOptions,
    'appVersion' | 'platform' | 'arch' | 'osRelease' | 'orcaChannel' | 'lookbackMinutes'
  >
): CollectedBundle {
  // Flush the active sink first so the very latest spans are present in the
  // file when we read it back. Without this, the user's most-recent action
  // before clicking Share might miss the bundle by a few hundred ms — which
  // is exactly the case "the thing I just did" they want diagnosed.
  if (sink) {
    sink.flush()
  }
  return _collectBundle({
    traceFilePath: getTraceFilePath(),
    maxFiles: DEFAULT_MAX_FILES,
    ...meta
  })
}

/** Upload a collected bundle payload. Returns the ticket ID on success;
 *  throws on any of the failure modes documented in `bundle.ts`. */
export async function uploadDiagnosticBundle(
  opts: UploadBundleOptions
): Promise<UploadBundleResult> {
  return _uploadBundle(opts)
}

export async function deleteDiagnosticBundle(opts: DeleteBundleOptions): Promise<void> {
  return _deleteBundle(opts)
}
