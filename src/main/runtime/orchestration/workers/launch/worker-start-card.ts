import { isBotGroupMemberSession } from '../../../../../shared/bots/bot-group'
import { runtimeBotGroups } from '../../../../bots/bot-group-runtime'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type {
  AgentJournalAgentHandoffItem,
  AgentJournalAgentStartItem
} from '../../../../../shared/agent-session/journal/agent-journal-creation-facts'
import type { AgentMessageSender } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { WORKER_AGENT_STARTING_STAGE } from '../../db/worker-dispatch/worker-awaiting-agent-stage'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../../addressing/orchestration-caller-identity'
import { botWorkHostOf } from '../../../../bots/bot-work-runtime'
import { prepareBotWorkerStart } from '../../../../bots/bot-work-start'

export type AgentCreationCard = AgentJournalAgentStartItem | AgentJournalAgentHandoffItem

/** Capture the caller's chat before its agent starts another; null when there is none.
 *  No publication work participates in launch settlement, including lookup and logging failures. */
export function prepareAgentCreationCard(
  callerSessionId: string | undefined
): ((card: () => AgentCreationCard) => void) | null {
  try {
    const host = getStructuredAgentSessionHost()
    const destination = callerSessionId && host?.captureAgentStartDestination(callerSessionId)
    if (!host || !destination) {
      return null
    }
    const captured = Promise.resolve(destination).catch((error: unknown) => {
      logStartCardFailure(error)
      return null
    })
    return (card) => {
      const observedAt = Date.now()
      void captured
        .then(async (destination) => {
          if (destination) {
            await host.appendAgentStart(destination, card(), observedAt)
          }
        })
        .catch(logStartCardFailure)
    }
  } catch (error) {
    logStartCardFailure(error)
    return null
  }
}

/** The started agent's sender, keeping the kind the launch knows when the lookup can't find it. */
export function startedAgentSender(
  runtime: OrcaRuntimeService,
  address: string,
  agent: AgentType | null,
  dispatchId?: string
): AgentMessageSender {
  const sender = runtime.orchestrationSenderNames.sender(address, dispatchId)
  return sender.agent || !agent ? sender : { ...sender, agent }
}

type WorkerStarted = {
  /** False for a start whose outcome is unknown: it may yet turn out ready, so a bot still records
   *  it, but the chat shows no card for it. */
  ready: boolean
  reusedTerminal?: boolean
  dispatchId: string
  taskId: string
  workerAddress: string
  task: string
  /** What this start launched; the only kind known for a worker on another host. */
  agent?: AgentType | null
  followUp?: AgentJournalAgentStartItem['followUp']
}

/** A remote worker's start, addressed by its Dispatch: the only address this host knows. */
export function dispatchWorkerStarted(
  ready: boolean,
  dispatchId: string,
  task: { id: string; spec: string },
  agent: AgentType | null
): WorkerStarted {
  const workerAddress = `dispatch:${dispatchId}`
  return { ready, dispatchId, taskId: task.id, workerAddress, task: task.spec, agent }
}

/** A started worker's card in its caller's chat, and a bot caller's work record. */
export function prepareWorkerStartCard(
  runtime: OrcaRuntimeService,
  caller: OrchestrationEntryCaller | undefined
): (args: WorkerStarted) => void {
  // A paired Orca has no chat here to show the card in, and is no bot here.
  const callerSession = sessionCallerOf(caller)
  const publish = prepareAgentCreationCard(callerSession?.sessionId)
  const groupWork =
    callerSession && isBotGroupMemberSession(callerSession.sessionId)
      ? {
          groups: runtimeBotGroups(runtime),
          operation: runtimeBotGroups(runtime).captureWorkerOperation(callerSession.sessionId)
        }
      : null
  const botWork = prepareBotWorkerStart(
    {
      bots: runtime.bots,
      botWork: runtime.botWork,
      hostOf: (dispatchId) => botWorkHostOf(runtime.getOrchestrationDb(), dispatchId)
    },
    callerSession
  )
  return (args) => {
    if (args.ready && !args.reusedTerminal && publish) {
      publish(() => ({
        kind: 'agent-start',
        dispatchId: args.dispatchId,
        worker: startedAgentSender(
          runtime,
          args.workerAddress,
          args.agent ?? null,
          args.dispatchId
        ),
        task: args.task,
        ...(args.followUp ? { followUp: args.followUp } : {})
      }))
    }
    if (groupWork) {
      void groupWork.groups
        .recordWorker(groupWork.operation, args.dispatchId)
        .catch(logStartCardFailure)
    }
    if (!args.reusedTerminal) {
      botWork(args)
    }
  }
}

function logStartCardFailure(error: unknown): void {
  try {
    console.warn('[orchestration] recording a started agent in its caller chat failed', error)
  } catch {
    // Display bookkeeping cannot change a successful launch.
  }
}

/** An unknown outcome with an agent launched may yet be a running worker: a bot records it, with no
 *  card. One that failed before any agent (a lost worktree reply) is no worker at all; one still
 *  starting is recorded when its wait settles. A reused terminal is no new worker, so it gets no card
 *  or bot record, but its Dispatch still joins the caller's group work. */
export function recordWorkerStartOutcome(
  record: (started: WorkerStarted) => void,
  outcome: unknown,
  started: Omit<WorkerStarted, 'ready' | 'workerAddress'> & {
    workerAddress: string | undefined
    reusedTerminal: boolean
  }
): void {
  const state = outcome && typeof outcome === 'object' && 'state' in outcome ? outcome.state : null
  const stage = outcome && typeof outcome === 'object' && 'stage' in outcome ? outcome.stage : null
  const { workerAddress, ...card } = started
  // A structured worker holding its brief for a still-starting agent is a worker already.
  const holdsBrief = state === 'starting' && stage === WORKER_AGENT_STARTING_STAGE
  if (workerAddress && (state === 'ready' || state === 'outcome_unknown' || holdsBrief)) {
    record({ ...card, workerAddress, ready: state === 'ready' })
  }
}
