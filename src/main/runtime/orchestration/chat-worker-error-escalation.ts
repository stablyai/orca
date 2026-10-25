import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { structuredAgentSessionStartFailure } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import type { StructuredAgentSessionRequestFailure } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'
import { tuiAgentDisplayName } from '../../../shared/tui-agent-display-names'
import { resolveStructuredWorkerIdentityForSession } from '../structured-worker-authority'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'
import { chatRequestError, isSenderOwnRejection } from './chat-worker-error-words'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow } from './types'
import { escalateWorkerFailure } from './worker-failure-escalation'

export type ChatWorkerErrorEscalationDeps = {
  /** Chat UI is on and the user left the Orchestration switch on. */
  enabled: () => boolean
  db: () => OrchestrationDb | null
  notify: (handle: string, messageType: string) => void
}

/** On while Chat UI is on, unless the user turned the Orchestration switch off. */
export function chatWorkerErrorEscalationEnabled(
  settings:
    | Pick<GlobalSettings, 'experimentalNativeChat' | 'orchestrationChatErrorEscalationEnabled'>
    | undefined
): boolean {
  return (
    settings?.experimentalNativeChat === true &&
    settings.orchestrationChatErrorEscalationEnabled !== false
  )
}

type ChatWorkerDispatch = { dispatch: DispatchContextRow; from: string }

/** The open Dispatch this session works, as a chat assignee or as a structured worker. */
function chatWorkerDispatches(sessionId: string, db: OrchestrationDb): ChatWorkerDispatch[] {
  const found: ChatWorkerDispatch[] = []
  if (isOrcaSessionId(sessionId)) {
    // A `/clear` successor keeps its root's address, so the Dispatch names the root.
    const address = formatOrcaSessionAddress(canonicalOrcaSessionId(sessionId))
    const dispatch = db.getActiveDispatchForTerminal(address)
    if (dispatch) {
      found.push({ dispatch, from: address })
    }
  }
  const worker = resolveStructuredWorkerIdentityForSession(sessionId, db)
  const dispatch = worker && db.getActiveDispatchForTerminal(worker.handle, worker.paneKey)
  if (worker && dispatch && !found.some((entry) => entry.dispatch.id === dispatch.id)) {
    found.push({ dispatch, from: worker.handle })
  }
  return found
}

function unrecordedError(request: StructuredAgentSessionRequestFailure) {
  const agentName = tuiAgentDisplayName(request.agent) ?? 'The agent'
  const fact = request.death?.failure ?? agentSessionFailureFact('providerExited')
  const context = { agentName, ...request.death }
  const words = request.death?.duringStartup
    ? structuredAgentSessionStartFailure({ exit: fact }, context)
    : {
        reason: agentSessionFailureWords(fact, { ...context, surface: 'row' }).text,
        rejection: fact
      }
  return request.outcome === 'interruption'
    ? { text: words.reason, kind: words.rejection.kind, detail: fact.detail?.text }
    : { text: `${agentName} ended its turn with an error and recorded no message.` }
}

function escalationId(dispatchId: string, request: StructuredAgentSessionRequestFailure): string {
  return `msg_chaterr_${createHash('sha256')
    .update(JSON.stringify([dispatchId, request.sessionId, request.kind, request.id]))
    .digest('hex')
    .slice(0, 24)}`
}

/** Capture authority synchronously; notification bookkeeping never rejects a committed write. */
export async function escalateChatWorkerError(
  request: StructuredAgentSessionRequestFailure,
  deps: ChatWorkerErrorEscalationDeps
): Promise<void> {
  try {
    if (!deps.enabled()) {
      return
    }
    const db = deps.db()
    const targets = db ? chatWorkerDispatches(request.sessionId, db) : []
    if (!db || targets.length === 0) {
      return
    }
    const deadline = performance.now() + 2_000
    const pending = request.death ? undefined : request.capturePendingOutput?.()
    // Settlement publication and promise continuations precede the ordered error read.
    await new Promise((resolve) => setImmediate(resolve))
    while (pending?.()) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)))
    }
    const snapshot = await request.read()
    if (!snapshot) {
      return
    }
    const recorded = chatRequestError(snapshot, request)
    const error =
      request.death &&
      (request.death.duringStartup ||
        !recorded ||
        (recorded.kind === 'providerExited' && !recorded.detail))
        ? unrecordedError(request)
        : recorded
    if (isSenderOwnRejection(error)) {
      return
    }
    const { text, detail, kind } = error ?? { ...unrecordedError(request), detail: undefined }
    for (const { dispatch, from } of targets) {
      // The journal read awaited: the Dispatch may have settled, or the user turned this off.
      const current = db.getDispatchContextById(dispatch.id)
      if (
        !deps.enabled() ||
        (current?.status !== 'pending' && current?.status !== 'dispatched') ||
        current.assignee_handle !== dispatch.assignee_handle
      ) {
        continue
      }
      escalateWorkerFailure(
        db,
        dispatch,
        {
          id: escalationId(dispatch.id, request),
          from,
          describe: (task) => ({
            subject: `Agent hit an error: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
            body: [
              `Worker ${from} hit an error while running task ${task}.`,
              `Error: ${text}`,
              ...(detail ? [`Details from the agent: ${detail}`] : []),
              'The task is still assigned to this chat, which keeps its history.'
            ].join('\n')
          }),
          payload: {
            taskId: dispatch.task_id,
            dispatchId: dispatch.id,
            handle: from,
            sessionId: request.sessionId,
            agent: request.agent,
            turnOutcome: request.outcome,
            requestId: request.id,
            ...(kind ? { failureKind: kind } : {}),
            error: text,
            ...(detail ? { detail } : {})
          }
        },
        deps.notify
      )
    }
  } catch (error) {
    console.warn('[orchestration] chat worker error escalation failed', request.sessionId, error)
  }
}
