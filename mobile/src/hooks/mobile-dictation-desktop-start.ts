import {
  DICTATION_FINISH_TIMEOUT_MS,
  isCurrentMobileDictationStart
} from './mobile-dictation-session-state'
import { sendAcrossConnectionMove } from './mobile-dictation-audio-chunk'
import { dictationSessionLostMessage } from '../dictation/mobile-dictation-setup'
import {
  dictationSessionCancel,
  dictationSessionFinish,
  dictationSessionStart
} from '../dictation/mobile-dictation-operations'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../../src/shared/rpc-contract/speech-params'
import { rpcPayloadMember } from '../transport/rpc-reader-payload'
import { probeLivenessWhileWaiting } from '../transport/rpc-liveness-probe-while-waiting'
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
  commitRecordingStart: (hostDedupesResends: boolean) => void
  rollbackRecordingStart: () => void
}

// The host refuses a phone's second start while its last one is still starting or closing; keyed by client so a start on any screen waits that out.
const hostWork = new WeakMap<RpcClient, Promise<void>>()

function trackHostWork(client: RpcClient, work: Promise<unknown>): void {
  hostWork.set(
    client,
    Promise.allSettled([hostWork.get(client), work]).then(() => undefined)
  )
}

export function settledDesktopDictationWork(client: RpcClient): Promise<void> {
  return hostWork.get(client) ?? Promise.resolve()
}

// Offline there is nothing to cancel against; the host drops a session its phone stops reaching, so never wait for a reconnect.
export function cancelDesktopDictation(client: RpcClient, dictationId: string): Promise<void> {
  const cancelled = probeLivenessWhileWaiting(
    client,
    dictationSessionCancel.request(client, { dictationId }, { failWhenDisconnected: true })
  ).then(
    () => undefined,
    () => undefined
  )
  trackHostWork(client, cancelled)
  return cancelled
}

// Returns the interpreted reply: the caller reads its text only after its staleness guard.
export async function finishDesktopDictation(
  client: RpcClient,
  dictationId: string
): Promise<unknown> {
  return dictationSessionFinish.interpret(
    await sendAcrossConnectionMove(client, () =>
      dictationSessionFinish.request(
        client,
        { dictationId },
        { timeoutMs: DICTATION_FINISH_TIMEOUT_MS }
      )
    )
  )
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
  await cancelDesktopDictation(client, dictationId)
}

export function startMobileDictationDesktopSession(
  options: StartMobileDictationDesktopSessionOptions
): Promise<boolean> {
  const started = startOnHost(options)
  trackHostWork(options.client, started)
  return started
}

async function startOnHost(options: StartMobileDictationDesktopSessionOptions): Promise<boolean> {
  const { client, dictationId } = options
  let hostDedupesResends = false

  try {
    // The mic is already recording, so a start stalled by a drop or a sleeping host must give up rather than hold it.
    const reply = await probeLivenessWhileWaiting(
      client,
      dictationSessionStart.request(
        client,
        { dictationId },
        { timeoutMs: MOBILE_DICTATION_RECONNECT_GRACE_MS }
      )
    ).catch(() => {
      // Only transport failures reject here; host refusals carry their own message through interpret.
      throw new Error(dictationSessionLostMessage())
    })
    const started = dictationSessionStart.interpret(reply)
    hostDedupesResends =
      started != null && rpcPayloadMember(started, 'dedupesResentChunks') === true
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
    await cancelDesktopDictation(client, dictationId)
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

  // Commit before returning so queued cancellation cannot resurrect recording after cleanup.
  options.commitRecordingStart(hostDedupesResends)
  return true
}
