import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import type { DictationCapture } from '../platform/audio-capture/dictation-capture-contract'

type OpenMobileDictationCaptureOptions = {
  capture: DictationCapture
  // Same start generation and still enabled.
  isCurrent: () => boolean
  isCurrentGeneration: () => boolean
  setIdle: () => void
  // Called just before begin, so chunks the microphone delivers from then on are held.
  hold: () => void
  close: () => void
}

// Native recording can throw part-way; treat it like a refused begin so the microphone is released.
function beginCapture(capture: DictationCapture): boolean {
  try {
    return capture.begin()
  } catch {
    return false
  }
}

// Opens the microphone and starts recording from the tap; false when a newer start, cancel or disable superseded it meanwhile.
export async function openMobileDictationCapture(
  options: OpenMobileDictationCaptureOptions
): Promise<boolean> {
  const { capture } = options
  let opened
  try {
    opened = await capture.open()
  } catch (err) {
    // Stale refusal must neither idle the replacement nor toast over the closure already reported by disable.
    if (!options.isCurrent()) {
      return false
    }
    // A page without audio grants can refuse capture; return to idle before rethrowing its message so starting cannot get stuck.
    options.setIdle()
    throw err instanceof Error ? err : new Error(String(err))
  }
  if (!options.isCurrent()) {
    capture.release()
    if (options.isCurrentGeneration()) {
      options.setIdle()
    }
    return false
  }
  if (!opened.ok) {
    options.setIdle()
    throw new Error(dictationSessionErrorMessage(opened.reason))
  }
  options.hold()
  if (!beginCapture(capture)) {
    options.close()
    options.setIdle()
    throw new Error(dictationSessionErrorMessage('recording-failed'))
  }
  return true
}
