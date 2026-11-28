import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { UnsentSendHold } from '../../agent-session-journal/queued-messages/journal-unsent-send-hold'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { StructuredAgentSessionStartFlights } from '../startup/structured-agent-session-start-flight'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentRegistry } from '../providers/structured-agent-registry'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
import type { StructuredAgentSessionRanRecorder } from '../options/structured-agent-session-ran-options'
import type { StructuredAgentSessionTurnContext } from '../structured-agent-session-turn-context'
import type { StructuredAgentSessionAcquireAborts } from '../startup/structured-agent-session-acquire-aborts'
import type { StructuredAgentSessionStartClaim } from '../startup/structured-agent-session-agent-start'
import type { StructuredAgentSessionStartReadiness } from '../startup/structured-agent-session-start-readiness'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from '../host/structured-agent-session-host-types'

export type StructuredAgentSessionDeliveryLoopDeps = {
  startFlights?: Pick<StructuredAgentSessionStartFlights, 'get'>
  activityChanged?: (sessionId: string) => void
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Track from enqueue so quit drains any child the start may create. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  startProviderChild: (
    sessionId: string,
    startedFor: string
  ) => Promise<StructuredAgentSessionStartClaim>
  /** Retire mismatched login/permission children under serialization. */
  retireOutgrownChild: (
    sessionId: string,
    continuingId?: string,
    next?: AgentJournalSubmission
  ) => Promise<void>
  immediatePermission?: (sessionId: string) => AgentChatPermissionChoice | null
  stopPermissionTransitionChild?: (sessionId: string) => Promise<void>
  retainedWork?: (sessionId: string, continuingId: string) => Promise<boolean>
  /** `due`: this chat's tools changed since its child launched and it owes no work (see
   *  `launchToolsRefreshDue`), so the input needs a child that has them; `pending`: it does, but
   *  the kept child's replay isn't durable yet, so the input reaches neither child for now. */
  launchToolsRefreshDue?: (sessionId: string, continuingId: string) => Promise<LaunchToolsRefresh>
  readiness: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => StructuredAgentSessionStartReadiness | null
  conversationFence: (sessionId: string) => number
  /** Settle sends covered by partial close; later sends remain eligible. False means settlement failed. */
  closeWhatTheUserClosed: (sessionId: string) => Promise<boolean>
  failureTextContext: (sessionId: string) => Promise<AgentSessionFailureWordsContext>
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  currentWork: (sessionId: string) => Promise<StructuredAgentSessionObservedWork | null>
  readWork: (sessionId: string) => JournalWorkReader
  /** Publish row-free changes in current work. */
  workChanged?: (sessionId: string) => void
  holdClosedInput?: (
    sessionId: string,
    clientMessageId: string,
    fence: number,
    cause: UnsentSendHold['cause']
  ) => Promise<void>
  settleLeftovers?: (sessionId: string, owner: () => void) => Promise<void>
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  childWorkOpen: (sessionId: string) => boolean
  stopping: (sessionId: string) => Promise<boolean>
  now: () => number
  acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  recordRanOptions?: StructuredAgentSessionRanRecorder
  turnContext?: StructuredAgentSessionTurnContext | undefined
}

export type LaunchToolsRefresh = 'due' | 'not-due' | 'pending'

/**
 * `launchTools.outdated` (no I/O) says Orca wrote some tools a chat may use since its child launched;
 * only `changed` says they are this chat's, so an edit to tools it doesn't get never restarts it.
 * Owed work is read once, and only when a refresh could follow.
 */
export function launchToolsRefreshDue(
  launchTools:
    | {
        outdated: (sessionId: string) => boolean
        changed: (sessionId: string) => Promise<boolean>
      }
    | undefined,
  owesWork: (sessionId: string, continuingId: string) => Promise<boolean>,
  /** See `StructuredAgentSessionAdapter.keptLaunchOutgrown`. */
  keptLaunchOutgrown?: (
    sessionId: string,
    toolsOutdated: boolean,
    owesWork: () => Promise<boolean>
  ) => boolean | 'pending' | undefined | Promise<boolean | 'pending' | undefined>
): ((sessionId: string, continuingId: string) => Promise<LaunchToolsRefresh>) | undefined {
  if (!launchTools && !keptLaunchOutgrown) {
    return undefined
  }
  return async (sessionId, continuingId) => {
    let owed: Promise<boolean> | undefined
    const owes = () => (owed ??= owesWork(sessionId, continuingId))
    const outdated = launchTools?.outdated(sessionId) === true
    const kept = await keptLaunchOutgrown?.(sessionId, outdated, owes)
    if (kept === 'pending') {
      return 'pending'
    }
    const outgrown = kept === true
    const due =
      kept !== false &&
      (outgrown || outdated) &&
      !(await owes()) &&
      (outgrown || (await launchTools?.changed(sessionId)) === true)
    return due ? 'due' : 'not-due'
  }
}

/** How long a send waits for an outgrown kept child's replay to be durable before it fails. */
const TOOLS_REFRESH_HOLD_MS = 30_000
const TOOLS_REFRESH_RECHECK_MS = 250

/** Asks again until the answer isn't `pending`, within the bound; the last answer is returned. */
export async function awaitToolsRefresh(
  refresh: () => Promise<LaunchToolsRefresh>,
  signal: AbortSignal | undefined
): Promise<LaunchToolsRefresh> {
  const until = Date.now() + TOOLS_REFRESH_HOLD_MS
  let answer = await waitForPromiseWithSignal(refresh(), signal)
  while (answer === 'pending' && Date.now() < until) {
    await waitForPromiseWithSignal(
      new Promise((resolve) => setTimeout(resolve, TOOLS_REFRESH_RECHECK_MS)),
      signal
    )
    answer = await waitForPromiseWithSignal(refresh(), signal)
  }
  return answer
}
