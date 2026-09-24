import { isCurrentMobileDictationStart } from './mobile-dictation-session-state'
import {
  dictationSessionCancel,
  dictationSessionStart
} from '../dictation/mobile-dictation-operations'
import type { RpcClient } from '../transport/rpc-client'

type StartMobileDictationDesktopSessionOptions = {
  client: RpcClient
  dictationId: string
  generation: number
  getCurrentGeneration: () => number
  getEnabled: () => boolean
  getActiveId: () => string | null
  clearActiveId: (dictationId: string) => void
  setIdle: () => void
  commitRecordingStart: () => boolean
  rollbackRecordingStart: () => void
}

function isCurrentStart(options: StartMobileDictationDesktopSessionOptions): boolean {
  return isCurrentMobileDictationStart(
    options.getCurrentGeneration(),
    options.generation,
    options.getEnabled(),
    options.getActiveId(),
    options.dictationId
  )
}

function canReportStartFailure(options: StartMobileDictationDesktopSessionOptions): boolean {
  return options.getCurrentGeneration() === options.generation && options.getEnabled()
}

function setIdleIfGenerationCurrent(options: StartMobileDictationDesktopSessionOptions): void {
  if (options.getCurrentGeneration() === options.generation) {
    options.setIdle()
  }
}

/** Cancel a start that went stale mid-startup: the desktop session is the only thing it holds. */
async function cancelStaleStart(options: StartMobileDictationDesktopSessionOptions): Promise<void> {
  const { client, dictationId } = options
  options.clearActiveId(dictationId)
  setIdleIfGenerationCurrent(options)
  await dictationSessionCancel.request(client, { dictationId }).catch(() => undefined)
}

export async function startMobileDictationDesktopSession(
  options: StartMobileDictationDesktopSessionOptions
): Promise<boolean> {
  const { client, dictationId } = options

  try {
    const reply = await dictationSessionStart.request(client, { dictationId })
    dictationSessionStart.interpret(reply)
  } catch (err) {
    const wasCurrent = isCurrentStart(options)
    // The hook opened the capture before this ran, and an open microphone holds the screen, so a
    // failure that is still this start's gives both back — through the same rollback the commit
    // failure below uses, because "undo the capture this start opened" is one thing the hook owns.
    //
    // Only while it is still current, though: there is one capture seam and it carries no start
    // identity. A stale rejection — A opened the capture, the user cancelled, B is recording —
    // would end B's microphone and hand back B's screen. Past the generation, the capture was
    // already ended by whatever superseded this start, or belongs to the one that did.
    if (wasCurrent) {
      try {
        options.rollbackRecordingStart()
      } catch {
        // Guarded for the reason the commit arm below is: a seam that throws on the way down must
        // not take the desktop cancel with it, nor replace the failure the caller is about to see.
      }
    }
    options.clearActiveId(dictationId)
    await dictationSessionCancel.request(client, { dictationId }).catch(() => undefined)
    // Awaited cleanup may overlap a newer start; stale work must not reset or
    // report over the replacement session.
    const shouldReport = wasCurrent && canReportStartFailure(options)
    setIdleIfGenerationCurrent(options)
    if (!shouldReport) {
      return false
    }
    throw err
  }

  // One check, in the same continuation as the commit below: nothing awaits between them now that
  // the screen is the microphone's, so a second one would re-read state nothing could have moved.
  if (!isCurrentStart(options)) {
    await cancelStaleStart(options)
    return false
  }

  try {
    // Committed here rather than after a return, which would let a queued cancel resurrect
    // microphone recording after cleanup.
    if (!options.commitRecordingStart()) {
      throw new Error('Failed to start microphone recording')
    }
  } catch (err) {
    const wasCurrent = isCurrentStart(options)
    // Native recording can partially start before throwing, so stop audio before
    // releasing the wake tag and remote session.
    try {
      options.rollbackRecordingStart()
    } catch {
      // Continue releasing independently owned resources after native audio failure.
    }
    options.clearActiveId(dictationId)
    await dictationSessionCancel.request(client, { dictationId }).catch(() => undefined)
    const shouldReport = wasCurrent && canReportStartFailure(options)
    setIdleIfGenerationCurrent(options)
    if (!shouldReport) {
      return false
    }
    throw err
  }
  return true
}
