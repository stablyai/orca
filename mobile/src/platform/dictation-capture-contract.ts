/**
 * Where dictation's audio comes from, as the hook that drives it sees it.
 *
 * One seam, two hosts. Natively it is `@orca/expo-two-way-audio` called directly; on the page it is
 * `native.audio.start|read|stop` over the bridge. Everything above it — the five composer states,
 * the generation guards, the pending-audio budget, where a transcript is routed — is the same code
 * on both, because the part that differs is the capability and the part that does not is the
 * product.
 *
 * The shape is the native one: a permission and an open, a start and a stop, and two event lanes.
 * That is deliberate. The page's pull is what `dictation-capture.web.ts` turns into these events,
 * so the flow above the seam cannot tell which host it is on, and the native half is the calls it
 * always made in the order it always made them. The screen is not here at all: an open microphone
 * holds it on the device side, under both halves.
 */

/**
 * One piece of captured audio.
 *
 * `data` is the field a microphone event already has, so a chunk is what
 * `enqueueMobileDictationAudioChunk` has always taken and the sender is untouched by the seam: raw
 * PCM is the one form both hosts agree on, the budget counts it, and the base64 for the wire is
 * built after the reserve exactly as it was. The page pays a decode for that — the shell's reply
 * carries base64 — which at 32 KB/s is the price of one chunk shape rather than two.
 */
export type DictationCaptureChunk = {
  readonly data: Uint8Array
  /**
   * Audio the capture had and could not hand over.
   *
   * Always zero natively, where the microphone reaches this process directly. On the page it is the
   * shell's ring filling faster than the drain empties it, which is the same condition the budget
   * refuses on — so both reach `MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE`, which is a state
   * the composer already renders.
   */
  readonly droppedBytes: number
}

/** Why a capture would not open. Both are device answers rather than faults: a shell that refused
 *  the call at all rejects instead, with the reason on it. */
export type DictationCaptureOpen =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'permission-denied' | 'unavailable' }

export type DictationCaptureSubscription = { readonly remove: () => void }

export type DictationCapture = {
  /** Runs the OS permission prompt if there is one and brings the engine up. */
  readonly open: () => Promise<DictationCaptureOpen>
  /** Starts producing chunks. False is a device that would not, which rolls the start back. */
  readonly begin: () => boolean
  /**
   * Stops producing chunks, after handing over everything the capture still holds.
   *
   * Asynchronous because of the page, where the audio lives in the shell's ring and comes back on
   * the stop's own reply: up to one drain interval of the utterance's tail is sitting there when
   * the user lifts the button, and no timer is coming for it. Natively that audio already reached
   * the hook as it was produced, so there the promise is already resolved.
   *
   * Never rejects. It runs on every exit including a throw, where a rejection would replace what
   * brought us here with a complaint about cleaning up after it.
   */
  readonly end: () => Promise<void>
  /** Gives the capture up for good; the screen's unmount calls it. */
  readonly release: () => void
  readonly onChunk: (
    handler: (chunk: DictationCaptureChunk) => void
  ) => DictationCaptureSubscription
  /**
   * The capture was taken away — a call, another app, a shell that no longer has one.
   *
   * No argument, because what the flow does about any of them is the same: cancel and tell the
   * desktop. Natively this is `onAudioInterruption`'s `began` and `blocked`; on the
   * page it is the same two riding a `read` reply, plus a read the shell refused, which is a
   * capture that is gone by another name.
   */
  readonly onInterruption: (handler: () => void) => DictationCaptureSubscription
}

/**
 * The rate a native engine produces microphone events at.
 *
 * 1,024 bytes of 16 kHz 16-bit PCM is 32 ms, so both engines emit 31.25 times a second. Named here
 * because the page's drain is priced against it: a page that read once per native event would put
 * 63 of the bridge's 64 in-flight slots into dictation on a two-second link.
 */
export const DICTATION_NATIVE_EVENT_INTERVAL_MS = 32

/**
 * How often the page drains the shell's ring, and therefore how often it forwards a chunk.
 *
 * Priced against `BRIDGE_MAX_PENDING_REQUESTS`, which is what bounds dictation rather than the
 * frame cap. Every `speech.dictation.chunk` is a forwarded request holding one of 64 slots for a
 * whole desktop round trip, so at the native event rate a two-second link leaves 62 of them in
 * flight and nothing for the screen around it. At this interval it is four, on the same 42 KiB/s:
 * the batch costs nothing but latency, and half a second of it is below what a transcript that
 * arrives after `finish` can show.
 *
 * The frame is never the bound. Half a second of 16 kHz 16-bit PCM is 16,000 bytes, which is
 * 21,336 characters of base64 against a 655,360-byte frame cap — 3.3% of one.
 */
export const DICTATION_CAPTURE_DRAIN_INTERVAL_MS = 500
