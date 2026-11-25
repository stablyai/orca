import { isCodexMethodRefusal } from '../../app-server/codex-app-server-request-error'
import {
  readCodexTurnId,
  readCodexTurnStatus
} from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from '../session-lifecycle/codex-structured-session-state'

const NO_PREDICTION = 'NO_PREDICTION'
// A guess is a short sentence; a longer one is not worth a frame to every reader.
const MAX_PREDICTION_LENGTH = 1000
// Codex bounds a sample at 30 s itself; this only covers a reply that never comes.
const SAMPLE_TIMEOUT_MS = 45_000

const PREDICTION_PROMPT = [
  'Do not call any tools and do not continue the task.',
  'Write the message the user is most likely to send you next, worded the way they write to',
  'you: a short, direct request of at most 20 words. Prefer a concrete next step that follows',
  'from your last reply. Reply with only that message, no quotes or preamble.',
  `Reply ${NO_PREDICTION} only if the user has said they are done.`
].join(' ')

type PredictionState = { sourceTurnId: string | null; unsupported?: true }

type NotificationEvent = {
  sessionId: string
  threadId: string
  method: string
  params: unknown
}

function readSampleText(result: unknown): { id: string; text: string } | null {
  const { responseId, text } = readRecord(result)
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (
    typeof responseId !== 'string' ||
    !trimmed ||
    trimmed === NO_PREDICTION ||
    trimmed.length > MAX_PREDICTION_LENGTH
  ) {
    return null
  }
  return { id: responseId, text: trimmed }
}

/** Asks Codex for its guess at the user's next prompt after each finished turn a reader shows. */
export class CodexComposerPredictions {
  private readonly readers = new Set<string>()
  // Per process: a relaunch re-learns whether its Codex supports sampling.
  private readonly states = new WeakMap<CodexSession, PredictionState>()

  constructor(
    private readonly sessions: ReadonlyMap<string, CodexSession>,
    private readonly deps: () => Pick<CodexStructuredSessionAdapterDeps, 'promptSuggestions'>
  ) {}

  readonly interestChanged = (sessionId: string, wanted: boolean): void => {
    if (wanted) {
      this.readers.add(sessionId)
    } else {
      this.readers.delete(sessionId)
    }
  }

  observe(session: CodexSession, event: NotificationEvent): void {
    if (event.threadId !== session.threadId) {
      return
    }
    const state = this.stateFor(session)
    if (event.method === 'turn/started') {
      state.sourceTurnId = null
      session.events?.setPromptSuggestion?.(null)
      return
    }
    if (event.method !== 'turn/completed' || readCodexTurnStatus(event.params) !== 'completed') {
      return
    }
    const turnId = readCodexTurnId(event.params)
    if (
      !turnId ||
      state.unsupported ||
      !this.readers.has(event.sessionId) ||
      !(this.deps().promptSuggestions?.() ?? false)
    ) {
      return
    }
    state.sourceTurnId = turnId
    void this.sample(event.sessionId, session, state, turnId)
  }

  private async sample(
    sessionId: string,
    session: CodexSession,
    state: PredictionState,
    turnId: string
  ): Promise<void> {
    let result: unknown
    try {
      result = await session.connection.request(
        'thread/sample',
        {
          threadId: session.threadId,
          expectedTurnId: turnId,
          prompt: PREDICTION_PROMPT,
          effort: 'low',
          threadSource: 'composer_predictions',
          turnTrigger: 'composer_predictions',
          responsesapiClientMetadata: { generation_trigger: 'composer_prediction' }
        },
        { timeoutMs: SAMPLE_TIMEOUT_MS }
      )
    } catch (error) {
      // Codex before 0.164 has no `thread/sample`; stop asking that process.
      if (isCodexMethodRefusal(error)) {
        state.unsupported = true
      }
      return
    }
    const suggestion = readSampleText(result)
    // A send, a new turn or a relaunch since the request makes the guess stale.
    if (
      !suggestion ||
      state.sourceTurnId !== turnId ||
      this.sessions.get(sessionId) !== session ||
      session.ended ||
      session.dispatchPending ||
      (session.activeTurnIds?.size ?? 0) > 0 ||
      !this.readers.has(sessionId)
    ) {
      return
    }
    session.events?.setPromptSuggestion?.(suggestion)
  }

  private stateFor(session: CodexSession): PredictionState {
    let state = this.states.get(session)
    if (!state) {
      state = { sourceTurnId: null }
      this.states.set(session, state)
    }
    return state
  }
}
