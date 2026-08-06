import type { CodexTrustGrantSessionVerifyClass } from './codex-app-server-client'
import { WSL_CODEX_NOT_FOUND_MESSAGE } from '../codex-accounts/wsl-codex-command'

/** Which install surface asked for the grant: the system-default real ~/.codex
 *  or a managed (mirror/per-account) home. Telemetry attribution only — the
 *  grant behaves identically; host_kind alone cannot distinguish the lanes
 *  (native hosts grant for both surfaces). */
export type CodexTrustGrantTelemetryLane = 'real-home' | 'managed'

export type CodexTrustGrantFallbackReason =
  | 'disabled'
  | 'no-managed-entries'
  | 'unsupported'
  | 'unsupported-cached'
  | 'verify-failed'
  | 'retry-cached'
  | 'error'

/** Closed classification of `reason: 'error'` fallbacks. Errors cross the
 *  grant-bridge envelope as message text (only timeout/unsupported keep their
 *  name), so classes are matched on the bounded message shapes each layer
 *  produces — never forwarded raw. */
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

// Why: hook-service is bundled into plain-node CLI entries where electron
// (and therefore the telemetry client) cannot load; the Electron main process
// injects the tracker at startup instead of a static import.
let telemetry: CodexTrustGrantTelemetry = () => {}

export function setCodexTrustGrantTelemetry(tracker: CodexTrustGrantTelemetry): void {
  telemetry = tracker
}

export function emitCodexTrustGrantTelemetry(event: CodexTrustGrantTelemetryEvent): void {
  try {
    telemetry(event)
  } catch (error) {
    // Why: observability must never turn a verified grant into fallback or
    // violate the launch-prep no-throw contract of the grant lane.
    console.warn('[codex-trust-grant] failed to emit telemetry', error)
  }
}
