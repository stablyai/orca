import { isDeliveredNativeChatUserMessage } from '../../shared/native-chat/input/native-chat-ask'
import { isInterruptedStatusMessage } from '../../shared/native-chat-types'
import { isNativeChatContextClear } from '../../shared/agent-session-context-clear'
import { isPositionalMessageQuestionRow } from './message-question-transcript-generation'
import type { MessageQuestionIngest } from './message-question-ingest'
import type { readIncrementalTranscriptMessages } from './transcript-incremental-reader'

type FoldInput = {
  filePath: string
  generation: string
  ingest: MessageQuestionIngest
  readContext: () => string
  writeContext: (context: string) => void
  seen: Set<string> | undefined
}

export function foldTranscriptQuestionMessages(
  messages: Awaited<ReturnType<typeof readIncrementalTranscriptMessages>>,
  input: FoldInput
): void {
  for (const message of messages) {
    let context = input.readContext()
    const positionalContext = JSON.stringify([context, input.generation])
    const fact = {
      id: message.id,
      at: message.timestamp,
      order: [message.transcriptOrder ?? 0, 0] as const
    }
    if (isNativeChatContextClear(message)) {
      input.ingest.retire(context, fact, positionalContext)
      context = message.id
      input.writeContext(context)
    }
    const rowContext = isPositionalMessageQuestionRow(input.filePath, message.id)
      ? JSON.stringify([context, input.generation])
      : context
    const otherContext =
      rowContext === context ? JSON.stringify([context, input.generation]) : context
    if (isDeliveredNativeChatUserMessage(message)) {
      input.ingest.deliver(otherContext, fact)
    } else if (isInterruptedStatusMessage(message)) {
      input.ingest.interruptContext(otherContext, fact)
    }
    for (const id of input.ingest.append(message, {
      context: rowContext,
      order: fact.order,
      turnId: null
    })) {
      input.seen?.add(id)
    }
  }
}
