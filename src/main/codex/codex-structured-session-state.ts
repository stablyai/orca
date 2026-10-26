import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { StructuredAgentSessionAtRestCommands } from '../native-chat/agent-session-wire/structured-agent-session-at-rest-commands'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { randomUUID } from 'node:crypto'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import { cancelProcessAcquisition } from '@orca/process-host/cancel-process-acquisition'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import type { openCodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  createCodexTurnOpenWaits,
  type CodexTurnOpenWaits
} from './codex-structured-turn-open-wait'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSkillReport } from './codex-structured-skill-report'
import type { CodexJournalTranslator } from './codex-structured-journal-translation'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexStructuredPermissionPolicy } from './codex-structured-permission-policy'
import type { StructuredLaunchRequest } from '../runtime/structured-agent-launch-composition'
import type {
  AgentModelCatalogSessionAccess,
  AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionProviderOpen } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { NativeChatVisualsLaunch } from '../native-chat/native-chat-visuals-delivery'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

export type CodexSessionCatalogAccess = AgentModelCatalogSessionAccess & {
  read?: (verifiedOnly?: boolean) => ReturnType<AgentModelCatalogStore['get']>
  demand?: (legacy?: boolean) => Promise<unknown>
}

export type CodexStructuredLaunch = {
  command: string
  args: string[]
  cwd: string
  codexHome: string | null
  resumeThreadId: string | null
  /** Replace an unsaved thread created by this session; never supersede a proven resume. */
  supersedeIfUnsaved?: boolean
  permissionPolicy?: CodexStructuredPermissionPolicy
  /** Open on the chosen model to avoid a first-turn switch. */
  model?: string
  /** Sealed child environment; envToDelete removes inherited keys. */
  env?: Record<string, string>
  envToDelete?: readonly string[]
  /** Command values that must survive the user's shell environment policy. */
  commandEnv?: Record<string, string>
  visuals?: NativeChatVisualsLaunch
}

/** Boundaries retain host receipt time through buffering and retries. */
export const CODEX_RECEIPT_TIMED_METHODS: ReadonlySet<string> = new Set([
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed'
])

export type CodexStructuredSessionEvent =
  | {
      type: 'notification'
      sessionId: string
      threadId: string
      method: string
      params: unknown
      /** Original host receipt time for CODEX_RECEIPT_TIMED_METHODS boundaries. */
      observedAt?: number
      /** Highest dispatch sequence armed when this turn-start was first received. */
      dispatchSequenceAtReceipt?: number
    }
  | { type: 'server-request'; sessionId: string; threadId: string; method: string; params: unknown }
  | { type: 'provider-frame'; sessionId: string; threadId: string; kind: string; payload: unknown }
  | {
      type: 'prompt'
      sessionId: string
      threadId: string
      method: string
      params: unknown
      codexItemId: string
      promptKey: string
    }
  | StructuredAgentSessionLifecycleEvent
  /** Translator-only compatibility for callers that do not participate in host recovery. */
  | { type: 'ended'; sessionId: string; reason: string; observedAt?: number }

export type CodexStructuredSessionAdapterDeps = {
  resolveAccountKind?: (home: string) => AgentSessionAccountKind | undefined
  atRestCommands?: StructuredAgentSessionAtRestCommands
  resolveLaunch: (input: StructuredLaunchRequest) => Promise<CodexStructuredLaunch>
  onEvent?: (event: CodexStructuredSessionEvent) => void
  logger?: StructuredAgentSessionLogger
  /** Delivered after journal admission; producer is the reporting child's sink. */
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
  /** Settle an admitted send by provider echo or rejection at its answered turn's end. */
  onDispatchSettledLate?: (
    input: { sessionId: string; clientMessageId: string } & (
      | { providerIdentity: AgentJournalItemIdentity }
      | ({
          state: 'rejected'
          answeredInTurn?: AgentJournalAnsweredTurnIdentity
        } & AgentJournalDispatchRejection)
    )
  ) => void
  /** The sends Codex holds (`CodexDispatchEchoes.heldSends`) changed with no journal row. */
  onHeldSendsChanged?: (input: { sessionId: string }) => void
  openConnection?: typeof openCodexAppServerConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintLinkId?: () => string
  mintAcquisitionGeneration?: () => string
  now?: () => number
  requestTimeoutMs?: number
  /** Host model catalog; sessions write their listings through and read back. */
  modelCatalog?: AgentModelCatalogStore
  readModelCatalog?: (
    sessionId: string,
    verifiedOnly?: boolean
  ) => ReturnType<AgentModelCatalogStore['get']>
  demandModelCatalog?: (sessionId: string, legacy?: boolean) => Promise<unknown>
}

export type CodexSession = {
  events?: StructuredAgentSessionEventSink
  account?: AgentSessionAccountKind
  connection: CodexAppServerConnection
  ended: boolean
  /** First observed child exit survives rejected settlement admission. */
  exitObservedAt?: number
  /** Preserve the initiating close's cause and reason through later exit reports. */
  orcaClose?: { requested: boolean; reason: Error }
  fence: number
  acquisitionGeneration: string
  threadId: string
  historyMode?: 'legacy' | 'paginated'
  /** Wire-observed open primary turns; rewind and untargeted Stop use these before journal admission. */
  activeTurnIds?: Set<string>
  /** Interrupt-acknowledged turns cannot accept steers while awaiting turn/completed. */
  abortedTurnIds?: Set<string>
  turnOpenWaits: CodexTurnOpenWaits
  dispatchPending?: boolean
  prompts: CodexAcquisitionWindow['prompts']
  options: Map<string, string>
  reportedOptions: {
    reportedPermissionMode?: string | null
    model?: string
    effort?: string
    serviceTier?: string | null
    serviceTierKnown?: true
  }
  /** The configured personality and tier a reset returns to, read before the first override. */
  nativeDefaults?: { personality?: string; serviceTier?: string }
  /** Overrides actually attempted on this child, independently of future saved picks. */
  appliedTurnOptions?: Readonly<Record<string, string>>
  /** Optional for adapters without a host catalog store. */
  catalogAccess?: CodexSessionCatalogAccess
  dispatchEchoes: CodexDispatchEchoes
  translator: CodexJournalTranslator | null
  /** Ephemeral compatibility roster; durable child records own runtime state. */
  backgroundTasks: CodexBackgroundTaskTracker
  skillReport?: CodexSkillReport
  unbindReadingControl?: () => void
  /** Terminates this exact child as an unexpected death and enters host recovery. */
  forceCloseUnexpected?: (reason: Error) => Promise<boolean>
}

export function mintCodexAcquisitionGeneration(deps: CodexStructuredSessionAdapterDeps): string {
  return deps.mintAcquisitionGeneration?.() ?? randomUUID()
}

export function codexSessionLifecycle(
  fence: number,
  acquisitionGeneration: string
): Pick<CodexSession, 'ended' | 'fence' | 'acquisitionGeneration' | 'turnOpenWaits'> {
  return {
    ended: false,
    fence,
    acquisitionGeneration,
    turnOpenWaits: createCodexTurnOpenWaits()
  }
}

export function assertCodexConnectionOpen(
  connection: Pick<CodexAppServerConnection, 'closed'>,
  sessionId: string
): void {
  if (connection.closed) {
    throw new Error(`codex app-server for session ${sessionId} exited while being acquired`)
  }
}

export function requireLiveCodexSession(
  sessions: Map<string, CodexSession>,
  sessionId: string
): CodexSession {
  const session = sessions.get(sessionId)
  if (!session || session.ended) {
    throw new Error(`no live codex app-server for session ${sessionId}`)
  }
  return session
}

export type CodexAcquisitionAttempt = {
  window: CodexAcquisitionWindow
  acquisitionGeneration?: string
  open?: StructuredAgentSessionProviderOpen
  dispose?: () => void
  cancelled: boolean
  requestedClose?: boolean
  exitProven: boolean
  exitError?: Error
  finished: Promise<void>
  finish: () => void
}

export function createCodexAcquisitionAttempt(): CodexAcquisitionAttempt {
  let finish = (): void => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    window: new CodexAcquisitionWindow(),
    cancelled: false,
    exitProven: false,
    finished,
    finish
  }
}

export class CodexAcquisitionRegistry {
  private readonly attempts = new Map<string, CodexAcquisitionAttempt>()
  private closing = false

  get size(): number {
    return this.attempts.size
  }

  start(sessionId: string): {
    previousAttempt: CodexAcquisitionAttempt | undefined
    attempt: CodexAcquisitionAttempt
  } {
    if (this.closing) {
      throw new Error('codex structured session adapter is closing')
    }
    const previousAttempt = this.attempts.get(sessionId)
    const attempt = createCodexAcquisitionAttempt()
    this.attempts.set(sessionId, attempt)
    return { previousAttempt, attempt }
  }

  assertCurrent(sessionId: string, attempt: CodexAcquisitionAttempt): void {
    if (this.closing || attempt.cancelled || this.attempts.get(sessionId) !== attempt) {
      throw new Error(`codex session ${sessionId} was superseded while being acquired`)
    }
  }

  get(sessionId: string): CodexAcquisitionAttempt | undefined {
    return this.attempts.get(sessionId)
  }

  deleteIfCurrent(sessionId: string, attempt: CodexAcquisitionAttempt): void {
    if (this.attempts.get(sessionId) === attempt) {
      this.attempts.delete(sessionId)
    }
  }

  restoreIfCurrent(
    sessionId: string,
    replacement: CodexAcquisitionAttempt,
    previous: CodexAcquisitionAttempt
  ): void {
    if (this.attempts.get(sessionId) === replacement) {
      this.attempts.set(sessionId, previous)
    }
  }

  async closeFailedAttempt(sessionId: string, attempt: CodexAcquisitionAttempt): Promise<boolean> {
    const stopped = (await attempt.window.connection?.close()) ?? true
    if (stopped) {
      attempt.exitProven = true
      this.deleteIfCurrent(sessionId, attempt)
    }
    return stopped
  }

  sessionIds(): IterableIterator<string> {
    return this.attempts.keys()
  }

  close(): void {
    this.closing = true
  }
}

export async function cancelCodexAcquisitionAttempt(
  attempt: CodexAcquisitionAttempt | undefined,
  requestedClose = true
): Promise<boolean> {
  if (!attempt) {
    return true
  }
  const closed = await cancelProcessAcquisition({
    cancel: () => {
      attempt.cancelled = true
      attempt.requestedClose = requestedClose
    },
    connection: () => attempt.window.connection,
    exitProven: () => attempt.exitProven,
    finished: attempt.finished
  })
  if (closed) {
    attempt.exitProven = true
    attempt.dispose?.()
  }
  return closed
}
