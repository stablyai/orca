import type { TelemetryConsentState } from '../../shared/telemetry-consent-types'
import type { MemorySnapshot, StatsSummary } from '../../shared/process-stats-types'

export type StatsApi = {
  getSummary: () => Promise<StatsSummary>
}

// Diagnostics IPC payloads; mirror the runtime types in `src/main/observability/{index,bundle}.ts`.
export type DiagnosticsStatusPayload = {
  readonly localFileEnabled: boolean
  readonly bundleEnabled: boolean
  readonly traceFilePath: string
  readonly traceFamilySize: number
  readonly disabledReason?:
    | 'do_not_track'
    | 'orca_telemetry_disabled'
    | 'orca_diagnostics_disabled'
    | 'ci'
}
export type DiagnosticsBundlePayload = {
  readonly bundleSubmissionId: string
  readonly bytes: number
  readonly spanCount: number
}
export type DiagnosticsUploadPayload =
  | {
      readonly ticketId: string
    }
  | {
      readonly canceled: true
    }

export type MemoryApi = {
  getSnapshot: () => Promise<MemorySnapshot>
}

export type DiagnosticsApi = {
  getStatus: () => Promise<DiagnosticsStatusPayload>
  collectBundle: (lookbackMinutes?: number) => Promise<DiagnosticsBundlePayload>
  openBundlePreview: (bundleSubmissionId: string) => Promise<void>
  discardBundlePreview: (bundleSubmissionId: string) => Promise<void>
  uploadBundle: (bundleSubmissionId: string) => Promise<DiagnosticsUploadPayload>
  deleteBundle: (ticketId: string) => Promise<void>
}

export type TelemetryApi = {
  /** Fire-and-forget track. Loose IPC typing on purpose — the main-side validator enforces;
   *  renderer sites should import `track<N>()` from lib/telemetry.ts, not reach here. */
  telemetryTrack: (name: string, props: Record<string, unknown>) => Promise<void>
  /** Flip the persisted opt-in preference. Subject to a per-session
   *  consent-mutation rate limit on the main side (≤5/session). */
  telemetrySetOptIn: (optedIn: boolean) => Promise<void>
  /** Diagnostic file controls (telemetry-error-tracking.md §User controls). Main does the FS/network
   *  work and retains upload payloads so the renderer can't read or substitute arbitrary bytes. */
  diagnostics: DiagnosticsApi
  /** Read-only effective consent state (+ reason if disabled) — env vars are main-side state the renderer can't read directly. */
  telemetryGetConsentState: () => Promise<TelemetryConsentState>
  /** Banner ✕ — persist `optedIn = true` silently. Separate channel from `telemetrySetOptIn`,
   *  whose `via` derivation would wrongly fire `telemetry_opted_in`. Same per-session rate limit. */
  telemetryAcknowledgeBanner: () => Promise<void>
  stats: StatsApi
  memory: MemoryApi
}
