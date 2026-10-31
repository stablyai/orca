import {
  createTranscriptQuestionRefreshCredit,
  type RefreshCredit
} from './transcript-question-refresh-credit'
import { readTranscriptQuestionCapture } from './transcript-question-acquisition'
import {
  createTranscriptQuestionPublication,
  type TranscriptQuestionMaterialization as RefreshResult
} from './transcript-question-publication'
import { foldTranscriptQuestionMessages } from './transcript-question-fold'
import type { MessageQuestionRepository } from './message-question-repository'
import { MessageQuestionIngest } from './message-question-ingest'
import { messageQuestionSourceId, type MessageQuestionSourceState } from './message-question-source'
import {
  messageQuestionTranscriptGeneration,
  qualifyMessageQuestionTranscript
} from './message-question-transcript-generation'
import type { NativeChatLineDecoder } from './transcript-tail-reader'
import {
  createIncrementalTranscriptState,
  type readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState
} from './transcript-incremental-reader'

type Frontier = NonNullable<MessageQuestionSourceState['file']>
export function createTranscriptQuestionSource(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  prepare: MessageQuestionRepository | (() => Promise<MessageQuestionRepository>)
) {
  const source = { kind: 'transcript' as const, filePath, agent, sessionId }
  const sourceId = messageQuestionSourceId(source)
  const state = createIncrementalTranscriptState()
  const abort = new AbortController()
  let repository: MessageQuestionRepository | undefined
  let ingest: MessageQuestionIngest | undefined
  let acquired: MessageQuestionSourceState | null = null
  let releaseOwner: (() => void) | undefined
  let contextVerified = false
  const publication = createTranscriptQuestionPublication(sourceId, sessionId)
  let context = 'root'
  let generation = ''
  let replay:
    | {
        before: ReturnType<MessageQuestionRepository['current']>['records']
        seen: Set<string>
        replaced: boolean
      }
    | undefined
  let capture: { end: number; frontiers: Frontier[] } | undefined
  let reconstruct = true
  let pendingRefresh: Promise<RefreshResult> | undefined
  let captured = false
  let nextRefresh: RefreshCredit | undefined
  let continuation: ReturnType<typeof setTimeout> | undefined
  let knownTail = 0
  const onDispose = new Set<() => void>()
  const unavailable = () => publication.unavailable(contextVerified, context)
  const materializeCurrent = () => publication.materialize(ingest!, contextVerified, context)
  function quarantine(): void {
    reconstruct = true
    contextVerified = false
    capture = undefined
    knownTail = 0
  }
  async function refresh(materialize: boolean): Promise<RefreshResult> {
    abort.signal.throwIfAborted()
    if (!repository) {
      const prepared = typeof prepare === 'function' ? await prepare() : prepare
      abort.signal.throwIfAborted()
      const saved = prepared.sourceState(source)
      const preparedIngest = new MessageQuestionIngest(prepared, source)
      repository = prepared
      ingest = preparedIngest
      acquired = saved
      generation = saved?.generation ?? ''
      releaseOwner = repository.ownSource(source, () => dispose())
    }
    let evidence: Awaited<ReturnType<typeof messageQuestionTranscriptGeneration>>
    try {
      const retained =
        !reconstruct && acquired?.file
          ? {
              generation,
              file: {
                ...acquired.file,
                offset: state.offset,
                boundary: state.boundary.toString('base64')
              }
            }
          : acquired
      evidence = await messageQuestionTranscriptGeneration(filePath, retained, abort.signal)
    } catch (error) {
      contextVerified = false
      throw error
    }
    abort.signal.throwIfAborted()
    const previous = acquired
    if (evidence.replaced) {
      quarantine()
      acquired = {
        generation: evidence.generation,
        file: { ...evidence.version, offset: 0, boundary: '' }
      }
    }
    if (reconstruct || !ingest) {
      const before = replay?.before ?? repository.current(source).records
      resetIncrementalTranscriptState(state)
      ingest = new MessageQuestionIngest(repository, source)
      context = 'root'
      generation = evidence.generation
      replay = { before, seen: new Set(), replaced: evidence.replaced || Boolean(replay?.replaced) }
      reconstruct = false
    }
    const activeIngest = ingest
    if (contextVerified && !capture && !replay && state.offset === evidence.version.size) {
      return materialize ? materializeCurrent() : { materialized: false }
    }
    const start: Frontier = {
      ...evidence.version,
      offset: state.offset,
      boundary: state.boundary.toString('base64')
    }
    if (!capture || evidence.version.size < capture.end) {
      capture = {
        end: evidence.version.size,
        frontiers: acquired?.file ? [acquired.file, start] : [start]
      }
    }
    const attempt = capture
    acquired = { generation, file: start }
    captured = true
    // The closing qualification observation owns EOF; a reader must not choose a later extent.
    if (state.offset < attempt.end) {
      contextVerified = false
      await readTranscriptQuestionCapture(
        filePath,
        state,
        decode,
        append,
        abort.signal,
        attempt.end,
        qualifyFrontier,
        quarantine
      )
    }
    try {
      await qualifyFrontier()
      if (state.offset !== attempt.end) {
        throw new Error('Question source acquisition incomplete')
      }
    } catch (error) {
      contextVerified = false
      throw error
    }
    abort.signal.throwIfAborted()
    if (replay?.replaced) {
      activeIngest.replace(
        replay.before.filter((record) => !replay?.seen.has(record.id)).map((record) => record.id),
        { id: `source:${generation}`, at: null }
      )
    }
    contextVerified = true
    capture = undefined
    // Only admitted folds reach irreversible materialization; failed storage retains the same ingest.
    const progressed =
      previous?.file?.offset !== state.offset || previous?.generation !== generation
    // Admission survives unrelated storage failure; the ingest retains its exact pending writes.
    replay = undefined
    activeIngest.admitSourceState(progressed ? (acquired ?? undefined) : undefined)
    if (!materialize) {
      return { materialized: false }
    }
    return materializeCurrent()

    async function qualifyFrontier(): Promise<void> {
      const end: Frontier = {
        ...evidence.version,
        offset: state.offset,
        boundary: state.boundary.toString('base64')
      }
      const qualified = await qualifyMessageQuestionTranscript(
        filePath,
        [...attempt.frontiers, end],
        abort.signal
      )
      if (qualified.replaced) {
        quarantine()
        throw new Error('Question source replaced during acquisition')
      }
      acquired = {
        generation,
        file: { ...qualified.version, offset: state.offset, boundary: end.boundary }
      }
      knownTail = qualified.version.size > attempt.end ? qualified.version.size : 0
    }
    function append(messages: Awaited<ReturnType<typeof readIncrementalTranscriptMessages>>): void {
      foldTranscriptQuestionMessages(messages, {
        filePath,
        generation,
        ingest: activeIngest,
        readContext: () => context,
        writeContext: (next) => {
          context = next
        },
        seen: replay?.seen
      })
    }
  }
  function credit(materialize: boolean): RefreshCredit {
    if (!nextRefresh) {
      nextRefresh = createTranscriptQuestionRefreshCredit(materialize)
    }
    nextRefresh.materialize ||= materialize
    return nextRefresh
  }
  function startRefresh(joined?: RefreshCredit, materialize = true): Promise<RefreshResult> {
    let succeeded = false
    const operation = refresh(joined?.materialize ?? materialize)
      .then((result) => {
        succeeded = !result.failure
        return result
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          unavailable()
        }
        throw error
      })
      .finally(() => {
        pendingRefresh = undefined
        captured = false
        if (!abort.signal.aborted && (nextRefresh || (succeeded && knownTail > state.offset))) {
          continuation = setTimeout(() => {
            continuation = undefined
            const joined = nextRefresh
            nextRefresh = undefined
            void startRefresh(joined).catch(() => {})
          }, 0)
          continuation.unref?.()
        }
      })
    pendingRefresh = operation
    if (joined) {
      void operation.then(joined.resolve, joined.reject)
    }
    return operation
  }
  function dispose(): void {
    if (abort.signal.aborted) {
      return
    }
    abort.abort()
    if (continuation) {
      clearTimeout(continuation)
    }
    continuation = undefined
    nextRefresh?.reject(abort.signal.reason)
    nextRefresh = undefined
    onDispose.forEach((notify) => notify())
    onDispose.clear()
    repository?.invalidate(sourceId)
    releaseOwner?.()
  }
  return {
    listeners: publication.listeners,
    onDispose,
    current: () => {
      abort.signal.throwIfAborted()
      return publication.current()
    },
    cancel: (ids: readonly string[], caller: string, now: number) => {
      abort.signal.throwIfAborted()
      if (!contextVerified || !ingest) {
        throw new Error('Current questions unavailable')
      }
      ingest.cancel(ids, caller, now)
      materializeCurrent()
    },
    refresh: (materialize = true) => {
      if (abort.signal.aborted) {
        return Promise.reject(abort.signal.reason)
      }
      const operation =
        continuation || (pendingRefresh && captured)
          ? credit(materialize).promise
          : (pendingRefresh ?? startRefresh(undefined, materialize))
      return operation.then((result) => {
        if (materialize) {
          const complete = result.materialized || result.failure ? result : materializeCurrent()
          if (complete.failure) {
            throw complete.failure.error
          }
        }
      })
    },
    dispose
  }
}
