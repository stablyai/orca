import type { StructuredAgentSessionChildWorkProducer } from '../../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type * as SessionAdapter from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  ClaudeStreamJsonConnection,
  openClaudeStreamJsonConnection
} from '../claude-stream-json-connection'
import type { ClaudeStructuredLaunch } from '../claude-structured-launch-resolution'
import type { StructuredLaunchRequest } from '../../runtime/structured-agent-launch-composition'
import type { ClaudeJournalTranslator } from '../claude-journal-translator-contract'
import type { ClaudePendingPrompt, ClaudePromptRegistry } from '../claude-prompt-registry'
import { cancelProcessAcquisition } from '@orca/process-host/cancel-process-acquisition'
import { randomUUID } from 'node:crypto'
import type { AgentSessionFastModeState } from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { ClaudeBackgroundTaskTracker } from '../claude-background-task-tracker'
import type { ClaudeChildWorkDecoder } from '../claude-child-work-decoder'
import type { ClaudeSlashCommandCatalog } from '../claude-slash-command-catalog'
import type { ClaudeAtRestCommandCatalog } from '../claude-at-rest-commands'
import type { ClaudeInitProof } from './claude-structured-init-proof'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'

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
      /** Present when an acknowledged replay opens a turn; folded replays only settle delivery. */
      startsTurn?: true
      /** Submission time for the acknowledged dispatch, absent when its send is unknown. */
      requestedAt?: number
      /** The submission this replay acknowledged, which opens the turn. */
      clientMessageId?: string
      /** On any other frame: the send the CLI started and has not echoed, whose turn output opens. */
      startedSend?: ClaudeStartedSend
      /** Host clock at receipt; stamped on turn boundaries only. */
      observedAt?: number
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
  | SessionAdapter.StructuredAgentSessionOptionsReportedEvent
  | {
      type: 'ended'
      sessionId: string
      reason: string
      failure?: SubmissionRejectionFact
      /** Present for first-hand child exits so the host can fence recovery. */
      cause?: 'unexpected-exit' | 'requested-close'
      fence?: number
      acquisitionGeneration?: string
      /** Host clock when the end was observed. */
      observedAt?: number
    }

export type ClaudeStartedSend = { clientMessageId: string; requestedAt?: number }

export type ClaudeLateDispatchOutcome =
  | {
      clientMessageId: string
      providerIdentity: AgentJournalItemIdentity
    }
  /** `unrun`: the CLI reported it removed the send without running it. */
  | ({ clientMessageId: string; state: 'rejected'; unrun?: true } & AgentJournalDispatchRejection)
  /** The CLI took the send and let it go unanswered: it may have run, so it is never re-sent. */
  | { clientMessageId: string; state: 'unknown'; reason: string }

export type ClaudeStructuredSessionAdapterDeps = {
  atRestCommands?: ClaudeAtRestCommandCatalog
  resolveLaunch: (input: StructuredLaunchRequest) => Promise<ClaudeStructuredLaunch>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
  /** Direct settlement path for provider-proven late dispatch outcomes. */
  onDispatchSettledLate?: (input: { sessionId: string } & ClaudeLateDispatchOutcome) => void
  /** Delivered after journaling; producer writes corrections to the reporting child's rows. */
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
  openConnection?: typeof openClaudeStreamJsonConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintLinkId?: () => string
  mintAcquisitionGeneration?: () => string
  now?: () => number
  requestTimeoutMs?: number
  persistHandle?: (input: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  logger?: StructuredAgentSessionLogger
  /** Advance the durable resume point in place at a turn end; bookkeeping, never a turn failure. */
  persistResumePoint?: (input: {
    sessionId: string
    providerSessionId: string
    leafUuid: string
    fence: number
  }) => Promise<void>
}

export type ClaudeDispatchWaiter = {
  resolve: (uuid: string | null) => void
  acceptsResult: boolean
  /** Submission settled by the replay, or null for provider-control turns. */
  clientMessageId: string | null
  /** Client uuid echoed by Claude so a replay is tied to its own dispatch. */
  sentUuid: string
  /** Sequence used to identify the latest pending dispatch for control ownership. */
  dispatchSequence: number
  /** Host submission instant owned by this exact dispatch. */
  requestedAt: number | null
  /** Set when the provider replay settled this waiter before send returned. */
  settledUuid?: string
  /** Settled with no echo (failed write, child exit, doubt after start); a replay may name it. */
  retired?: boolean
  /** The CLI's last non-terminal `command_lifecycle` state for this send; in memory only. */
  commandLifecycle?: 'queued' | 'started'
  /** Bounded digest/summary for compatibility CLIs that mint UUIDs. */
  replayContentKey: string
}

export type ClaudeSession = {
  connection: ClaudeStreamJsonConnection
  providerSessionId: string
  /** Latest main-chain message seen on the live stream, mid-turn included. */
  leafUuid: string | null
  /** `leafUuid` at the last completed turn; the only leaf close and exit persist. */
  turnEndLeafUuid: string | null
  fence: number
  acquisitionGeneration: string
  prompts: ClaudePromptRegistry
  dispatchWaiters: ClaudeDispatchWaiter[]
  /** Sends the frame being handled settled, until their settlements reach the host. */
  unreportedSettlements?: ReadonlySet<string>
  /** Bounded identities for dispatches settled without an echo; a late replay still accepts one. */
  retiredDispatchWaiters: ClaudeDispatchWaiter[]
  /** Once a retired waiter is evicted, legacy content-only replay matching is unsafe. */
  replayContentFallbackBlocked: boolean
  options: Map<string, string>
  reportedOptions: {
    model?: string
    effort?: string
    fastMode?: boolean
    reportedPermissionMode?: string | null
  }
  /** CLI-resolved env/settings for the next request; lower priority than held options and turn reports. */
  appliedOptions?: { model?: string; effort?: string }
  /** CLI settings resolved before a turn changed them, when no launch override hid that value. */
  configuredDefaults?: { model?: string; effort?: string }
  /** Mutation at which the provider last reported its Fast routing state. */
  fastModeReportedMutation?: number
  fastModeState?: AgentSessionFastModeState
  fastModeDisabledReason?: string
  fastModeDisabledMutation?: number
  fastModePerSessionOptIn?: boolean
  /** Mutation sequence of the last model report; newer writes outrank it. */
  reportedModelMutation: number
  /** Options whose recorded value the provider reported, not merely accepted. */
  confirmedOptions: Set<string>
  /** Inputs carried by launch or accepted controls, independent of provider reports. */
  appliedInputOptions: Map<string, string>
  /** The model the child was launched with, as `--model`; null when it runs the CLI's own. */
  launchedModel: string | null
  /** What Orca put on this process's command line, and the first root init's answer; this process only. */
  launchIntent?: { permissionMode?: string; model?: string }
  firstRootInit?: { permissionMode: string | null }
  /** A launched model the CLI answered `model_not_found` for; reported until a new pick. */
  retiredModel?: string
  /** Fast was omitted from launch settings and must be applied before message input. */
  fastModeAtStart: boolean
  /** CLI-advertised protocol capabilities from init; gates interrupt-receipt handling. */
  capabilities: readonly string[]
  backgroundTasks: ClaudeBackgroundTaskTracker
  childWork: ClaudeChildWorkDecoder
  /** Commands seeded by init and updated by later init or commands_changed frames. */
  commands: ClaudeSlashCommandCatalog
  /** Monotonic fence advanced when a dispatch starts, including unresolved dispatches. */
  dispatchSequence: number
  /** Fences overlapping option writes so a late completion cannot restore stale state. */
  settingsObservation?: { pending: boolean }
  optionMutationSequence: number
  /** Latest resume point written at a turn end; close and exit persist after it settles. */
  resumePointWrite?: { leafUuid: string; settled: Promise<void> }
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
  unbindReadingControl?: () => void
  /** Provider identity and initialize proof retained for the host-awaited open. */
  link: AgentSessionProviderHandleLink
  initialization: {
    proof: ClaudeInitProof
    account: ClaudeStructuredLaunch['account']
    resumesTranscript: boolean
    /** The account home the child writes its transcript in, pinned at launch. */
    claudeConfigDir: string
    cwd: string
    history: { leafUuid: string | null; covered: boolean; contextActivity: number }
    onLateRefusal: (error: Error) => void
  }
}

export function mintClaudeAcquisitionGeneration(deps: ClaudeStructuredSessionAdapterDeps): string {
  return deps.mintAcquisitionGeneration?.() ?? randomUUID()
}

/** Retain observed exits until settlement so delayed acquisition cleanup can find their proof. */
export type ClaudeSessionExit = {
  observedAt: number
  connection: ClaudeStreamJsonConnection
  session: ClaudeSession
  error: Error
  /** The exit path's first proof attempt; retries must observe this result. */
  closePromise?: Promise<boolean>
  /** Shared lifecycle settlement for concurrent proof retries. */
  settlementPromise?: Promise<void>
  /** Never-rejecting cleanup/settlement barrier for exits observed before lifecycle publication. */
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
  /** The resolved launch's account, read by the translator to word a sign-in failure. */
  account?: ClaudeStructuredLaunch['account']
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

export type ClaudeAcquireCallbacks = {
  deliver: (attempt: ClaudeAcquisitionAttempt, sessionId: string, event: () => void) => void
  emit: (
    session: ClaudeSession | null,
    events: StructuredAgentSessionEventSink | undefined,
    event: ClaudeStructuredSessionEvent
  ) => void
  handleExit: (sessionId: string, attempt: ClaudeAcquisitionAttempt, error: Error) => void
  /** The root exited during a close Orca began: finishes that close for this exact child. */
  finishClose: (sessionId: string, attempt: ClaudeAcquisitionAttempt) => void
  settleExit: (sessionId: string, exit: ClaudeSessionExit) => Promise<void>
}
