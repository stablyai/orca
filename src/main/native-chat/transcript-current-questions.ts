import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { getStructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-registry'
import { messageQuestionsFor, type MessageQuestionRepository } from './message-question-repository'
import type { CurrentRequestsProjection } from './agent-session-wire/agent-session-current-requests'
import type { NativeChatLineDecoder } from './transcript-tail-reader'
import { createTranscriptQuestionSource } from './transcript-question-source'

type Source = ReturnType<typeof createTranscriptQuestionSource> & {
  users: number
  idle?: ReturnType<typeof setTimeout>
}
const sources = new WeakMap<MessageQuestionRepository, Map<string, Source>>()
const SOURCE_IDLE_MS = 30_000

function hostRepository(): MessageQuestionRepository {
  const database = getStructuredAgentSessionHost()?.deps.journalDatabase
  if (!database) {
    throw new Error('Current questions repository unavailable')
  }
  return messageQuestionsFor(database)
}

function retainSource(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  repository: MessageQuestionRepository
) {
  agent = resolveNativeChatTranscriptAgent(agent) ?? agent
  let ownedSources = sources.get(repository)
  if (!ownedSources) {
    ownedSources = new Map()
    sources.set(repository, ownedSources)
  }
  const key = JSON.stringify([filePath, agent, sessionId])
  let source = ownedSources.get(key)
  if (!source) {
    source = {
      ...createTranscriptQuestionSource(filePath, agent, sessionId, decode, repository),
      users: 0
    }
    ownedSources.set(key, source)
    const created = source
    const dispose = created.dispose
    const releaseOwner = repository.ownSource(
      { kind: 'transcript', filePath, agent, sessionId },
      () => created.dispose()
    )
    created.dispose = () => {
      if (created.idle) {
        clearTimeout(created.idle)
      }
      dispose()
      created.listeners.clear()
      releaseOwner()
      if (ownedSources.get(key) === created) {
        ownedSources.delete(key)
      }
    }
  }
  if (source.idle) {
    clearTimeout(source.idle)
  }
  source.idle = undefined
  source.users++
  const retained = source
  let released = false
  return {
    source,
    release: () => {
      if (released) {
        return
      }
      released = true
      if (--retained.users > 0 || ownedSources.get(key) !== retained) {
        return
      }
      // A unary query may assemble its next piece after the final stream has ended.
      retained.idle = setTimeout(() => {
        retained.dispose()
        if (ownedSources.get(key) === retained) {
          ownedSources.delete(key)
        }
      }, SOURCE_IDLE_MS)
      retained.idle.unref?.()
    }
  }
}

/** Stream interest and unary queries share one canonical read model, never read authority. */
export function acquireTranscriptCurrentQuestions(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  notify: (projection: CurrentRequestsProjection) => void,
  repository: MessageQuestionRepository = hostRepository()
) {
  const retained = retainSource(filePath, agent, sessionId, decode, repository)
  const { source } = retained
  source.listeners.add(notify)
  const current = source.current()
  if (current) {
    notify(current)
  }
  return {
    refresh: source.refresh,
    dispose: () => {
      source.listeners.delete(notify)
      retained.release()
    }
  }
}

async function withTranscriptQuestionSource<T>(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  run: (source: Source) => T,
  signal: AbortSignal | undefined,
  repository: MessageQuestionRepository
): Promise<T> {
  signal?.throwIfAborted()
  const retained = retainSource(filePath, agent, sessionId, decode, repository)
  const deadline = AbortSignal.timeout(15_000)
  const querySignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    await waitForPromiseWithSignal(retained.source.refresh(), querySignal)
    querySignal.throwIfAborted()
    return run(retained.source)
  } finally {
    retained.release()
  }
}

/** No subscriber is required; finite query/idle leases preserve publication identity across pieces. */
export function queryTranscriptCurrentQuestions<T>(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  read: (projection: CurrentRequestsProjection) => T,
  signal?: AbortSignal,
  repository: MessageQuestionRepository = hostRepository()
): Promise<T> {
  return withTranscriptQuestionSource(
    filePath,
    agent,
    sessionId,
    decode,
    (source) => {
      const projection = source.current()
      if (!projection) {
        throw new Error('Current questions unavailable')
      }
      return read(projection)
    },
    signal,
    repository
  )
}

/** Source refresh applies canonical answer facts before committing an exact-ID cancellation. */
export function cancelTranscriptCurrentQuestions(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  ids: readonly string[],
  caller: string,
  now: number,
  signal?: AbortSignal,
  repository: MessageQuestionRepository = hostRepository()
): Promise<void> {
  return withTranscriptQuestionSource(
    filePath,
    agent,
    sessionId,
    decode,
    (source) => source.cancel(ids, caller, now),
    signal,
    repository
  )
}
