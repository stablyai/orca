import { z } from 'zod'

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

/**
 * What the native event body actually is; the union above is derived from it, never asserted.
 * Own-property parse: zod reads a shape key straight off the value, so an inherited `reason` would
 * otherwise count as one the shell sent.
 */
const loadStatePayloadSchema = z.object({
  state: z.string(),
  reason: z.string().optional()
})

export type MobileWebShellLoadStatePayload = z.infer<typeof loadStatePayloadSchema>

function isFailureReason(value: string | undefined): value is MobileWebShellFailureReason {
  return MOBILE_WEB_SHELL_FAILURE_REASONS.some((reason) => reason === value)
}

function ownEnumerableFields(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  return Object.fromEntries(Object.entries(payload))
}

/** Answers null for anything it does not recognise; a caller drops those rather than guessing. */
export function parseMobileWebShellLoadState(payload: unknown): MobileWebShellLoadState | null {
  const fields = ownEnumerableFields(payload)
  if (fields === null) {
    return null
  }
  const parsed = loadStatePayloadSchema.safeParse(fields)
  if (!parsed.success) {
    return null
  }
  const { state, reason } = parsed.data
  if (state === 'loading' || state === 'ready') {
    return { state }
  }
  if (state !== 'failed') {
    return null
  }
  return isFailureReason(reason) ? { state: 'failed', reason } : null
}
