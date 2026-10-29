// Share raw PCM chunks so both hosts reserve budgets before wire encoding.
export type DictationCaptureChunk = {
  readonly data: Uint8Array
  // Zero for direct native events; page ring overflow reports lost bytes so it reaches the same connection-slow state as budget refusal.
  readonly droppedBytes: number
}

// Permission/unavailable are device outcomes; bridge refusal rejects with its reason.
export type DictationCaptureOpen =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'permission-denied' | 'unavailable' }

export type DictationCaptureSubscription = { readonly remove: () => void }

export type DictationCapture = {
  readonly open: () => Promise<DictationCaptureOpen>
  readonly begin: () => boolean
  // End only after delivering the stop reply’s final ring audio; native events already delivered theirs. Never reject from exit cleanup.
  readonly end: () => Promise<void>
  readonly release: () => void
  readonly onChunk: (
    handler: (chunk: DictationCaptureChunk) => void
  ) => DictationCaptureSubscription
  // Notify loss without a reason argument because callers treat every source alike: native began/blocked, page equivalents, or refused reads.
  readonly onInterruption: (handler: () => void) => DictationCaptureSubscription
}

// 1024-byte 16 kHz/16-bit events arrive every 32 ms; forwarding each would consume almost all 64 request slots on a two-second link.
export const DICTATION_NATIVE_EVENT_INTERVAL_MS = 32

// Batch at 500 ms so a two-second desktop round trip holds four forwards instead of about 63. Each 16 KB PCM batch fits well below the bridge frame cap.
export const DICTATION_CAPTURE_DRAIN_INTERVAL_MS = 500
