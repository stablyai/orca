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
    // Capture already holds the screen; roll both back only while this start is current. A stale start could otherwise stop its replacement’s microphone. Capture itself has no start identity.
    if (wasCurrent) {
      try {
        options.rollbackRecordingStart()
      } catch {
        // A throwing rollback must neither skip desktop cancellation nor replace the original failure.
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

  // No await separates this check and commit; nothing can supersede the start between them.
  if (!isCurrentStart(options)) {
    await cancelStaleStart(options)
    return false
  }

  try {
    // Commit before returning so queued cancellation cannot resurrect recording after cleanup.
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
