import type { CodexTrustGrantSessionVerifyClass } from './codex-app-server-client'
import { WSL_CODEX_NOT_FOUND_MESSAGE } from '../codex-accounts/wsl-codex-command'

/** Retain legacy lanes for the telemetry schema and dashboards. */
export type CodexTrustGrantTelemetryLane = 'real-home' | 'managed'

export type CodexTrustGrantFallbackReason =
  | 'disabled'
  | 'no-managed-entries'
  | 'unsupported'
  | 'unsupported-cached'
  | 'verify-failed'
  | 'retry-cached'
  | 'error'

/** Classify failures into bounded labels without forwarding raw error messages. */
export type CodexTrustGrantErrorClass =
  | 'binary-missing'
  | 'timeout'
  | 'entry-failed'
  | 'early-exit'
  | 'rpc-failed'
  | 'unexpected'

export type CodexTrustGrantVerifyClass =
  | CodexTrustGrantSessionVerifyClass
  | 'unexpected-key'
  | 'duplicate-key'
  | 'coverage'

export function classifyCodexTrustGrantError(error: unknown): CodexTrustGrantErrorClass {
  if (!(error instanceof Error)) {
    return 'unexpected'
  }
  if (error.name === 'CodexAppServerTimeoutError') {
    return 'timeout'
  }
  const message = error.message
  if (message.includes('codex trust-grant entry')) {
    return 'entry-failed'
  }
  if (
    /^spawn (?:.*[\\/])?codex(?:\.(?:cmd|exe|bat))? ENOENT$/.test(message) ||
    message.includes(WSL_CODEX_NOT_FOUND_MESSAGE)
  ) {
    return 'binary-missing'
  }
  if (message.includes('exited before completing the session')) {
    return 'early-exit'
  }
  if (/codex app-server \S+ failed:/.test(message)) {
    return 'rpc-failed'
  }
  return 'unexpected'
}

export type CodexTrustGrantTelemetryEvent = {
  outcome: 'granted' | 'fallback' | 'verify_failed'
  hostKind: 'native' | 'wsl'
  lane: CodexTrustGrantTelemetryLane
  reason?: CodexTrustGrantFallbackReason
  errorClass?: CodexTrustGrantErrorClass
  verifyClass?: CodexTrustGrantVerifyClass
}

type CodexTrustGrantTelemetry = (event: CodexTrustGrantTelemetryEvent) => void

// Inject telemetry because plain-Node CLI bundles cannot import its Electron dependencies.
let telemetry: CodexTrustGrantTelemetry = () => {}

export function setCodexTrustGrantTelemetry(tracker: CodexTrustGrantTelemetry): void {
  telemetry = tracker
}

export function emitCodexTrustGrantTelemetry(event: CodexTrustGrantTelemetryEvent): void {
  try {
    telemetry(event)
  } catch (error) {
    // Telemetry failures must not change the grant outcome.
    console.warn('[codex-trust-grant] failed to emit telemetry', error)
  }
}
