import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  ClaudeStreamJsonConnection,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudePendingPrompt, ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { cancelProcessAcquisition } from '../../shared/child-process/cancel-process-acquisition'
import { randomUUID } from 'node:crypto'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import type { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'

export type ClaudeAuthDiagnostic = {
  apiKeySourceConfigured: boolean
  baseUrlConfigured: boolean
  authTokenConfigured: boolean
  apiKeyConfigured: boolean
  settingSources: readonly string[]
}

export type ClaudeStructuredSessionEvent =
  | {
      type: 'message'
      sessionId: string
      message: Record<string, unknown>
      /** Present only when this replay acknowledged Orca's in-flight dispatch. */
      startsTurn?: true
    }
  | { type: 'provider-frame'; sessionId: string; kind: string; payload: unknown }
  | { type: 'prompt'; sessionId: string; prompt: ClaudePendingPrompt }
  | { type: 'prompt-cancelled'; sessionId: string; promptKey: string }
  | { type: 'options'; sessionId: string; models: unknown[] }
  | {
      type: 'handle'
      sessionId: string
      providerSessionId: string
      leafUuid: string | null
      fence: number
    }
  | { type: 'auth-diagnostic'; sessionId: string; diagnostic: ClaudeAuthDiagnostic }
  | {
      type: 'ended'
      sessionId: string
      reason: string
      /** Present for first-hand child exits so the host can fence recovery. */
      cause?: 'unexpected-exit' | 'requested-close'
      fence?: number
      acquisitionGeneration?: string
      settlementRetryRequired?: boolean
    }

export type ClaudeStructuredSessionAdapterDeps = {
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
  }) => Promise<ClaudeStructuredLaunch>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
  onBackgroundTasksChanged?: (
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null
  ) => void
  openConnection?: typeof openClaudeStreamJsonConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintLinkId?: () => string
  mintAcquisitionGeneration?: () => string
  now?: () => number
  requestTimeoutMs?: number
  initTimeoutMs?: number
  dispatchAckTimeoutMs?: number
  persistHandle?: (input: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  /** Read the durable transcript branch after a child has flushed its final rows. */
  readTranscriptLeaf?: (input: {
    providerSessionId: string
    previousLeafUuid: string | null
    /** Account-scoped Claude config root that owns this provider session. */
    claudeConfigDir: string
  }) => Promise<string | null>
}

export type ClaudeDispatchWaiter = {
  resolve: (uuid: string | null) => void
  timer: ReturnType<typeof setTimeout>
  acceptsResult: boolean
  /** Client uuid echoed by Claude so a replay is tied to its own dispatch. */
  sentUuid: string
  /** Sequence used to fence a late identity from a newer dispatch. */
  dispatchSequence: number
  /** Set when the provider replay settled this waiter before send returned. */
  settledUuid?: string
  /** The waiter timed out or its write failed, but its replay may still arrive. */
  retired?: boolean
  /** Bounded digest/summary for compatibility CLIs that mint UUIDs. */
  replayContentKey: string
}

export type ClaudeSession = {
  connection: ClaudeStreamJsonConnection
  providerSessionId: string
  /** Durable transcript files live under this account's `projects` directory. */
  claudeConfigDir: string
  leafUuid: string | null
  fence: number
  acquisitionGeneration: string
  prompts: ClaudePromptRegistry
  dispatchWaiters: ClaudeDispatchWaiter[]
  /** Bounded identities for dispatches whose ack was unknown when they returned. */
  retiredDispatchWaiters: ClaudeDispatchWaiter[]
  /** Once a retired waiter is evicted, legacy content-only replay matching is unsafe. */
  replayContentFallbackBlocked: boolean
  options: Map<string, string>
  reportedOptions: { model?: string; effort?: string }
  /** `optionMutationSequence` when `reportedOptions.model` was last observed, so a
   *  write still awaiting its first turn outranks the report it will replace. */
  reportedModelMutation: number
  /** Options whose recorded value the provider reported, not merely accepted. */
  confirmedOptions: Set<string>
  restoreSkippedOptions: Set<string>
  /** CLI-advertised protocol capabilities from init; gates interrupt-receipt handling. */
  capabilities: readonly string[]
  /** Provider uuid of the most recently admitted turn, if one is active. */
  activeTurnId?: string
  backgroundTasks: ClaudeBackgroundTaskTracker
  /** Monotonic fence advanced when a dispatch starts, including unresolved dispatches. */
  dispatchSequence: number
  /** Dispatch sequence that admitted activeTurnId. */
  activeTurnSequence?: number
  /** Fences overlapping option writes so a late completion cannot restore stale state. */
  optionMutationSequence: number
  /** Shared durable-close write; a failed write clears this for a retry. */
  closePersistence?: Promise<void>
  /** Shared full close/finalization operation; a failed operation clears this for a retry. */
  closeFinalization?: Promise<boolean>
  /** Set only after the durable close write succeeds, before lifecycle emission. */
  closeFinalized?: boolean
  /** Set once `ended` has been emitted, so a persistence retry cannot repeat it. */
  closeEnded?: boolean
  translator: ClaudeJournalTranslator | null
  events: StructuredAgentSessionEventSink | undefined
}

export function mintClaudeAcquisitionGeneration(deps: ClaudeStructuredSessionAdapterDeps): string {
  return deps.mintAcquisitionGeneration?.() ?? randomUUID()
}

/**
 * The first-hand exit that removed a published session. Kept until the session
 * is acquired again so acquisition cleanup that arrives after the exit finds
 * what the ladder observed, not an absence it would otherwise report as proven.
 */
export type ClaudeSessionExit = {
  connection: ClaudeStreamJsonConnection
  /** Full session identity retained until its child tree is proven gone. */
  session: ClaudeSession
  error: Error
  /** The exit path's first proof attempt; retries must observe this result. */
  closePromise?: Promise<boolean>
  /** Shared lifecycle settlement for concurrent proof retries. */
  settlementPromise?: Promise<void>
  /** The whole ladder-then-settle tail, retained so a barrier can await an exit
   *  that is observed but not yet published. Never rejects. */
  publication?: Promise<void>
}

export type ClaudeAcquisitionAttempt = {
  connection: ClaudeStreamJsonConnection | null
  prompts: ClaudePromptRegistry
  buffered: (() => void)[]
  published: boolean
  cancelled: boolean
  exitProven: boolean
  finished: Promise<void>
  finish: () => void
}

export function createClaudeAcquisitionAttempt(
  prompts: ClaudePromptRegistry
): ClaudeAcquisitionAttempt {
  let finish = (): void => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    connection: null,
    prompts,
    buffered: [],
    published: false,
    cancelled: false,
    exitProven: false,
    finished,
    finish
  }
}

export class ClaudeAcquisitionRegistry {
  private readonly attempts = new Map<string, ClaudeAcquisitionAttempt>()
  private closing = false

  get size(): number {
    return this.attempts.size
  }

  start(
    sessionId: string,
    prompts: ClaudePromptRegistry
  ): {
    previous: ClaudeAcquisitionAttempt | undefined
    attempt: ClaudeAcquisitionAttempt
  } {
    if (this.closing) {
      throw new Error('claude structured session adapter is closing')
    }
    const previous = this.attempts.get(sessionId)
    const attempt = createClaudeAcquisitionAttempt(prompts)
    this.attempts.set(sessionId, attempt)
    return { previous, attempt }
  }

  assertCurrent(sessionId: string, attempt: ClaudeAcquisitionAttempt): void {
    if (this.closing || attempt.cancelled || this.attempts.get(sessionId) !== attempt) {
      throw new Error(`claude session ${sessionId} was superseded while being acquired`)
    }
  }

  get(sessionId: string): ClaudeAcquisitionAttempt | undefined {
    return this.attempts.get(sessionId)
  }

  deleteIfCurrent(sessionId: string, attempt: ClaudeAcquisitionAttempt): void {
    if (this.attempts.get(sessionId) === attempt) {
      this.attempts.delete(sessionId)
    }
  }

  restoreIfCurrent(
    sessionId: string,
    replacement: ClaudeAcquisitionAttempt,
    previous: ClaudeAcquisitionAttempt
  ): void {
    if (this.attempts.get(sessionId) === replacement) {
      this.attempts.set(sessionId, previous)
    }
  }

  sessionIds(): IterableIterator<string> {
    return this.attempts.keys()
  }

  close(): void {
    this.closing = true
  }
}

export async function cancelClaudeAcquisitionAttempt(
  attempt: ClaudeAcquisitionAttempt | undefined
): Promise<boolean> {
  if (!attempt) {
    return true
  }
  return cancelProcessAcquisition({
    cancel: () => {
      attempt.cancelled = true
    },
    connection: () => attempt.connection,
    exitProven: () => attempt.exitProven,
    finished: attempt.finished
  })
}

/** What an acquisition hands back to the adapter that owns the session map:
 *  event delivery ordered against publication, and the two exit settlements. */
export type ClaudeAcquireCallbacks = {
  deliver: (attempt: ClaudeAcquisitionAttempt, sessionId: string, event: () => void) => void
  emit: (
    session: ClaudeSession | null,
    events: StructuredAgentSessionEventSink | undefined,
    event: ClaudeStructuredSessionEvent
  ) => void
  handleExit: (sessionId: string, attempt: ClaudeAcquisitionAttempt, error: Error) => void
  settleExit: (sessionId: string, exit: ClaudeSessionExit) => Promise<void>
}
