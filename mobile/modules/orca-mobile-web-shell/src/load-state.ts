import { z } from 'zod'

// Parse native load events; caller owns recovery, view never reloads/retries.
// generation-unreadable: delete host cache and download once. document-load-failed: refetch only if the files fail verification, else remount once. render-process-gone: remount once without deletion; memory pressure/provider updates look like bad bundles.
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

// Check own properties: Zod shape reads would otherwise accept inherited reason as a native event.
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
