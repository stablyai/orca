import type {
  NativeChatCurrentRequestsRead,
  NativeChatCancelCurrentQuestions
} from '../../shared/agent-session-current-requests-wire'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { readCurrentRequestsPiece } from './agent-session-wire/agent-session-current-requests'
import { resolveSessionFilePath } from './session-file-resolver'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
import {
  queryTranscriptCurrentQuestions,
  cancelTranscriptCurrentQuestions
} from './transcript-current-questions'

/** Callers authorize the resource and resolve its execution-host path before entering this reader. */
export async function readNativeChatCurrentRequests(
  request: NativeChatCurrentRequestsRead,
  signal?: AbortSignal
) {
  const deadline = AbortSignal.timeout(15_000)
  const ownedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const decode = nativeChatLineDecoderForAgent(request.agent)
  if (!decode) {
    throw new Error('Current questions unavailable')
  }
  const filePath = await waitForPromiseWithSignal(
    resolveSessionFilePath(request.agent, request.sessionId, request, ownedSignal),
    ownedSignal
  )
  if (!filePath) {
    throw new Error('Current questions unavailable')
  }
  return queryTranscriptCurrentQuestions(
    filePath,
    request.agent,
    request.sessionId,
    decode,
    (projection) => readCurrentRequestsPiece(projection, request),
    ownedSignal
  )
}

export async function cancelNativeChatCurrentQuestions(
  request: NativeChatCancelCurrentQuestions,
  caller: string,
  signal?: AbortSignal
): Promise<void> {
  const deadline = AbortSignal.timeout(15_000)
  const ownedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const decode = nativeChatLineDecoderForAgent(request.agent)
  if (!decode) {
    throw new Error('Current questions unavailable')
  }
  const filePath = await waitForPromiseWithSignal(
    resolveSessionFilePath(request.agent, request.sessionId, request, ownedSignal),
    ownedSignal
  )
  if (!filePath) {
    throw new Error('Current questions unavailable')
  }
  await cancelTranscriptCurrentQuestions(
    filePath,
    request.agent,
    request.sessionId,
    decode,
    request.ids,
    caller,
    Date.now(),
    ownedSignal
  )
}
