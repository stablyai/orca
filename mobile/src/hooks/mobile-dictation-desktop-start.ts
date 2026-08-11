import {
  MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS,
  isCurrentMobileDictationStart
} from './mobile-dictation-session-state'
import type { MobileDictationKeepAwakeOwner } from './mobile-dictation-keep-awake'
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
  keepAwakeOwner: MobileDictationKeepAwakeOwner
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

// Cancel a start that went stale mid-startup. The wake-lock release and remote
// cancel are independent, so run them concurrently: awaiting release first can
// queue behind a still-running acquisition and delay cancel for the remainder
// of the native timeout.
async function cancelStaleStart(
  options: StartMobileDictationDesktopSessionOptions,
  { releaseKeepAwake }: { releaseKeepAwake: boolean }
): Promise<void> {
  const { client, dictationId, keepAwakeOwner } = options
  options.clearActiveId(dictationId)
  setIdleIfGenerationCurrent(options)
  const cleanups: Promise<unknown>[] = [
    client.sendRequest('speech.dictation.cancel', { dictationId })
  ]
  if (releaseKeepAwake) {
    cleanups.push(keepAwakeOwner.release(dictationId))
  }
  await Promise.allSettled(cleanups)
}

export async function startMobileDictationDesktopSession(
  options: StartMobileDictationDesktopSessionOptions
): Promise<boolean> {
  const { client, dictationId, keepAwakeOwner } = options

  try {
    const response = await client.sendRequest('speech.dictation.start', { dictationId })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
  } catch (err) {
    const wasCurrent = isCurrentStart(options)
    options.clearActiveId(dictationId)
    await client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
    // Awaited cleanup may overlap a newer start; stale work must not reset or
    // report over the replacement session.
    const shouldReport = wasCurrent && canReportStartFailure(options)
    setIdleIfGenerationCurrent(options)
    if (!shouldReport) {
      return false
    }
    throw err
  }

  if (!isCurrentStart(options)) {
    await cancelStaleStart(options, { releaseKeepAwake: false })
    return false
  }

  // Keep-awake is acquired only after the desktop session exists, so stale
  // mobile starts can be canceled without holding a screen-lock tag. It is
  // best-effort: Android throws with no current Activity, and a screen-lock
  // nicety must not abort an otherwise viable dictation — nor delay recording
  // past a small budget when native calls hang. A late acquisition finishes in
  // the background; the serialized keep-awake queue orders any later release
  // after it.
  await new Promise<void>((resolve) => {
    const budgetTimer = setTimeout(resolve, MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS)
    keepAwakeOwner
      .acquire(dictationId)
      .catch((err: unknown) => console.error('Keep-awake activation failed', err))
      .finally(() => {
        clearTimeout(budgetTimer)
        resolve()
      })
  })

  if (!isCurrentStart(options)) {
    await cancelStaleStart(options, { releaseKeepAwake: true })
    return false
  }

  try {
    // Commit in the same continuation as the final stale check; returning first
    // would let a queued cancel resurrect microphone recording after cleanup.
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
    await Promise.allSettled([
      keepAwakeOwner.release(dictationId),
      client.sendRequest('speech.dictation.cancel', { dictationId })
    ])
    const shouldReport = wasCurrent && canReportStartFailure(options)
    setIdleIfGenerationCurrent(options)
    if (!shouldReport) {
      return false
    }
    throw err
  }
  return true
}
