import { isDeliveredNativeChatUserMessage } from '../../shared/native-chat/input/native-chat-ask'
import { isInterruptedStatusMessage } from '../../shared/native-chat-types'
import { isNativeChatContextClear } from '../../shared/agent-session-context-clear'
import type { MessageQuestionRepository } from './message-question-repository'
import { MessageQuestionIngest } from './message-question-ingest'
import { messageQuestionSourceId, type MessageQuestionSourceState } from './message-question-source'
import {
  messageQuestionTranscriptGeneration,
  isPositionalMessageQuestionRow
} from './message-question-transcript-generation'
import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../shared/agent-session-current-requests-capability'
import {
  currentRequestsProjection,
  type CurrentRequestsProjection
} from './agent-session-wire/agent-session-current-requests'
import type { NativeChatLineDecoder } from './transcript-tail-reader'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState
} from './transcript-incremental-reader'
import {
  readTranscriptFileVersion,
  transcriptFileVersionChanged,
  type TranscriptFileVersion
} from './transcript-file-version'

export function createTranscriptQuestionSource(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  repository: MessageQuestionRepository
) {
  const source = { kind: 'transcript' as const, filePath, agent, sessionId }
  const sourceId = messageQuestionSourceId(source)
  const state = createIncrementalTranscriptState()
  const abort = new AbortController()
  let ingest = new MessageQuestionIngest(repository, source)
  let savedState = repository.sourceState(source)
  let version: TranscriptFileVersion | undefined
  let projection: CurrentRequestsProjection | undefined
  let pending: ReturnType<typeof ingest.current>['pending'] | undefined
  let context = 'root'
  let generation = savedState?.generation ?? ''
  let serial = Promise.resolve()
  const listeners = new Set<(projection: CurrentRequestsProjection) => void>()
  const owner = {}
  function publish(snapshot: ReturnType<typeof ingest.current>): void {
    const boundary = JSON.stringify([sourceId, context])
    if (
      pending === snapshot.pending &&
      projection?.marker.owner === `${projection.identity}:${boundary}`
    ) {
      return
    }
    const payload = {
      blocking: [],
      asyncQuestions: snapshot.pending,
      context: { sessionId, boundary }
    }
    pending = snapshot.pending
    const nextProjection = currentRequestsProjection(
      owner,
      sessionId,
      { actionablePrompts: () => [], viewKey: () => boundary },
      AGENT_SESSION_CURRENT_REQUESTS_V2,
      payload,
      sourceId
    )
    projection = nextProjection
    listeners.forEach((notify) => notify(nextProjection))
  }
  async function refresh(): Promise<void> {
    abort.signal.throwIfAborted()
    const next = await readTranscriptFileVersion(filePath, abort.signal)
    abort.signal.throwIfAborted()
    if (version && !transcriptFileVersionChanged(next, version) && next.size === state.offset) {
      publish(ingest.current())
      return
    }
    const evidence = await messageQuestionTranscriptGeneration(filePath, savedState, abort.signal)
    const replay = version === undefined || evidence.replaced
    const before = replay ? repository.current(source).records : []
    const seen = new Set<string>()
    if (replay) {
      resetIncrementalTranscriptState(state)
      ingest = new MessageQuestionIngest(repository, source)
      context = 'root'
    }
    generation = evidence.generation
    const append = (messages: Awaited<ReturnType<typeof readIncrementalTranscriptMessages>>) => {
      for (const message of messages) {
        const nativeContext = context
        const positionalContext = JSON.stringify([context, generation])
        const fact = {
          id: message.id,
          at: message.timestamp,
          order: [message.transcriptOrder ?? 0, 0] as const
        }
        if (isNativeChatContextClear(message)) {
          ingest.retire(nativeContext, fact)
          ingest.retire(positionalContext, fact)
          context = message.id
        }
        const rowContext = isPositionalMessageQuestionRow(filePath, message.id)
          ? JSON.stringify([context, generation])
          : context
        const otherContext =
          rowContext === context ? JSON.stringify([context, generation]) : context
        if (isDeliveredNativeChatUserMessage(message)) {
          ingest.deliver(otherContext, fact)
        } else if (isInterruptedStatusMessage(message)) {
          ingest.interruptContext(otherContext, fact)
        }
        for (const id of ingest.append(message, {
          context: rowContext,
          order: fact.order,
          turnId: null
        })) {
          seen.add(id)
        }
      }
    }
    append(
      await readIncrementalTranscriptMessages(
        filePath,
        state,
        decode,
        append,
        undefined,
        undefined,
        abort.signal,
        true
      )
    )
    const completed = await readTranscriptFileVersion(filePath, abort.signal)
    // Never certify a partial/racing replay as the complete current set.
    if (transcriptFileVersionChanged(completed, next)) {
      version = undefined
      return
    }
    if (replay && evidence.replaced) {
      ingest.replace(
        before.filter((record) => !seen.has(record.id)).map((record) => record.id),
        {
          id: `source:${generation}`,
          at: null
        }
      )
    }
    const sourceState: MessageQuestionSourceState = {
      generation,
      file: { ...completed, offset: state.offset, boundary: state.boundary.toString('base64') }
    }
    abort.signal.throwIfAborted()
    const snapshot = ingest.current(sourceState)
    savedState = sourceState
    version = completed
    publish(snapshot)
  }
  return {
    listeners,
    current: () => {
      abort.signal.throwIfAborted()
      return projection
    },
    cancel: (ids: readonly string[], caller: string, now: number) => {
      abort.signal.throwIfAborted()
      publish(ingest.cancel(ids, caller, now))
    },
    refresh: () => {
      const run = serial.then(refresh)
      serial = run.catch(() => {})
      return run
    },
    dispose: () => {
      abort.abort()
      repository.invalidate(sourceId)
    }
  }
}
