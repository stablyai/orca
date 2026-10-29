import { createPendingAskScanner } from '../../shared/native-chat/input/native-chat-ask'
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
  boundaryFingerprint,
  readTranscriptFileVersion,
  transcriptFileVersionChanged,
  type TranscriptFileVersion
} from './transcript-file-version'

type Source = ReturnType<typeof createSource>
const sources = new Map<string, Source>()

function createSource(filePath: string, sessionId: string, decode: NativeChatLineDecoder) {
  const state = createIncrementalTranscriptState()
  const abort = new AbortController()
  let scan = createPendingAskScanner()
  let version: TranscriptFileVersion | undefined
  let projection: CurrentRequestsProjection | undefined
  let json: string | undefined
  let serial = Promise.resolve()
  const listeners = new Set<(projection: CurrentRequestsProjection) => void>()
  const owner = {}
  async function refresh(): Promise<void> {
    abort.signal.throwIfAborted()
    const next = await readTranscriptFileVersion(filePath, abort.signal)
    if (version && !transcriptFileVersionChanged(next, version) && next.size === state.offset) {
      return
    }
    const replaced =
      version &&
      (next.identity !== version.identity ||
        next.size <= state.offset ||
        (await boundaryFingerprint(filePath, state.offset, abort.signal)) !==
          state.boundary.toString('base64'))
    if (replaced) {
      resetIncrementalTranscriptState(state)
      scan = createPendingAskScanner()
    }
    const append = (messages: Parameters<typeof scan.append>[0][]) => messages.forEach(scan.append)
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
    version = next
    // A racing rewrite is replayed by the existing watcher before it declares completeness.
    if (transcriptFileVersionChanged(completed, next)) {
      return
    }
    const payload = {
      blocking: [],
      asyncQuestions: scan.current().contributors,
      context: { sessionId, boundary: `${filePath}:${next.identity}` }
    }
    const nextJson = JSON.stringify(payload)
    if (json === nextJson) {
      return
    }
    json = nextJson
    const nextProjection = currentRequestsProjection(
      owner,
      sessionId,
      { actionablePrompts: () => [], viewKey: () => payload.context.boundary },
      AGENT_SESSION_CURRENT_REQUESTS_V2,
      payload,
      next.identity
    )
    projection = nextProjection
    listeners.forEach((notify) => notify(nextProjection))
  }
  return {
    listeners,
    current: () => projection,
    refresh: () => {
      const run = serial.then(refresh)
      serial = run.catch(() => {})
      return run
    },
    dispose: () => abort.abort()
  }
}

/** Existing watchers share one streaming source scan; the final subscriber releases its read model. */
export function acquireTranscriptCurrentQuestions(
  filePath: string,
  agent: string,
  sessionId: string,
  decode: NativeChatLineDecoder,
  notify: (projection: CurrentRequestsProjection) => void
) {
  const key = JSON.stringify([filePath, agent, sessionId])
  let source = sources.get(key)
  if (!source) {
    source = createSource(filePath, sessionId, decode)
    sources.set(key, source)
  }
  source.listeners.add(notify)
  const current = source.current()
  if (current) {
    notify(current)
  }
  return {
    refresh: source.refresh,
    dispose: () => {
      source.listeners.delete(notify)
      if (source.listeners.size === 0) {
        source.dispose()
        sources.delete(key)
      }
    }
  }
}
