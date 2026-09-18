/**
 * The load state the native shell view reports, and the parser that rebuilds the union from the
 * flat dictionary a native event carries.
 *
 * Recovery is the caller's, never the view's: the view retries nothing and reloads nothing.
 * `generation-unreadable` and `document-load-failed` mean the cached generation is suspect, so the
 * caller deletes that host's cache and downloads once. `render-process-gone` remounts once and
 * never deletes, because renderer memory pressure and a WebView provider update are
 * indistinguishable here from a bad bundle.
 */
export const MOBILE_WEB_SHELL_FAILURE_REASONS = [
  /** The generation directory has no readable manifest, or declares an asset we refuse to map. */
  'generation-unreadable',
  /** A fence we could not install, so nothing was loaded. Terminal. */
  'isolation-unavailable',
  /** The main frame failed to load, or its response was refused. */
  'document-load-failed',
  /** The WebView content process died. */
  'render-process-gone'
] as const

export type MobileWebShellFailureReason = (typeof MOBILE_WEB_SHELL_FAILURE_REASONS)[number]

export type MobileWebShellLoadState =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; reason: MobileWebShellFailureReason }

/** What the native event body actually is. The union above is derived from it, never asserted. */
export type MobileWebShellLoadStatePayload = { state: string; reason?: string }

function isFailureReason(value: unknown): value is MobileWebShellFailureReason {
  return MOBILE_WEB_SHELL_FAILURE_REASONS.some((reason) => reason === value)
}

// hasOwn, not `in`: the payload crosses the native bridge, and an inherited `reason` must not be
// read as one the shell sent.
function readOwnField(payload: object, key: string): unknown {
  return Object.hasOwn(payload, key) ? Reflect.get(payload, key) : undefined
}

/** Answers null for anything it does not recognise; a caller drops those rather than guessing. */
export function parseMobileWebShellLoadState(payload: unknown): MobileWebShellLoadState | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const state = readOwnField(payload, 'state')
  if (state === 'loading' || state === 'ready') {
    return { state }
  }
  if (state !== 'failed') {
    return null
  }
  const reason = readOwnField(payload, 'reason')
  return isFailureReason(reason) ? { state: 'failed', reason } : null
}
