import type { MinidumpCrashSignature } from './minidump-crash-signature'

const STATUS_BREAKPOINT = 0x80000003
// Why: Skia aborts a failed pixel allocation through SK_ABORT, not Chromium's OOM path, so on a commit-starved
// host the death is a plain CHECK (Scan-37 r29: `SkBitmap.cpp:252 assertf(this->tryAllocPixels(...))`).
const ALLOCATION_CHECK_MESSAGE = /tryAllocPixels|out of memory/i
// The recorder and the recovery path stamp the same render-process-gone dispatch; this only absorbs clock jitter.
const PAIRING_TOLERANCE_MS = 1_000
const MAX_REMEMBERED_CRASHES = 8

const allocationCheckCrashTimes: number[] = []

/** Called once a renderer dump's signature is parsed; remembers the crash when its CHECK is an allocation failure. */
export function noteRendererCrashSignature(
  crashedAtMs: number,
  signature: MinidumpCrashSignature
): void {
  if (
    signature.processType !== 'renderer' ||
    signature.exceptionCode === undefined ||
    signature.exceptionCode >>> 0 !== STATUS_BREAKPOINT ||
    !ALLOCATION_CHECK_MESSAGE.test(signature.checkMessage ?? '')
  ) {
    return
  }
  allocationCheckCrashTimes.push(crashedAtMs)
  if (allocationCheckCrashTimes.length > MAX_REMEMBERED_CRASHES) {
    allocationCheckCrashTimes.shift()
  }
}

/** Whether the renderer that died at `goneAt` left a dump naming an allocation-failure CHECK. */
export function isRendererAllocationCheckCrash(goneAt: number): boolean {
  return allocationCheckCrashTimes.some(
    (crashedAtMs) => Math.abs(crashedAtMs - goneAt) <= PAIRING_TOLERANCE_MS
  )
}
