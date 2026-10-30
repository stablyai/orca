import { acquireTranscriptCurrentQuestions } from './transcript-current-questions'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'

export function createTranscriptQuestionRefresh(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  args: SubscribeNativeChatTranscriptArgs,
  ownerSignal: AbortSignal,
  closed: () => boolean
) {
  let questions: ReturnType<typeof acquireTranscriptCurrentQuestions> | undefined
  let questionsRefresh: Promise<void> | undefined
  let questionsRequested = false
  function refreshQuestions(): void {
    if (!args.onCurrentRequests || closed()) {
      return
    }
    if (questionsRefresh) {
      questionsRequested = true
      return
    }
    questionsRefresh = (async () => {
      const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(15_000)])
      if (closed() || !args.onCurrentRequests) {
        return
      }
      questions ??= acquireTranscriptCurrentQuestions(
        filePath,
        args.agent,
        args.sessionId,
        decode,
        args.onCurrentRequests,
        undefined,
        args.prepareCurrentRequests
      )
      await waitForPromiseWithSignal(questions.refresh(), signal)
    })()
      .catch(() => {
        // Current controls retry on the owning watcher's next reconciliation; history stays usable.
      })
      .finally(() => {
        questionsRefresh = undefined
        if (questionsRequested) {
          questionsRequested = false
          refreshQuestions()
        }
      })
  }
  return { refresh: refreshQuestions, dispose: () => questions?.dispose() }
}
