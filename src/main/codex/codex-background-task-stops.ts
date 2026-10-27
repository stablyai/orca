import { CodexAppServerTimeoutError } from './codex-app-server-session'
import {
  boundedTimeout,
  terminateCodexBackgroundTerminals,
  type CodexBackgroundTerminal
} from './codex-background-terminals'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import { interruptCodexSubagents } from './codex-subagent-interrupts'
import type { AgentSessionBackgroundTaskStops } from '../../shared/agent-child-work-stop-targets'

type StopTally = { stopped: number; survived: boolean }

/** Subagent interrupts are always available; command stops require background-terminal support. */
export function codexBackgroundTaskStops(
  session: CodexSession | undefined
): AgentSessionBackgroundTaskStops | undefined {
  return session
    ? { supportsTaskStop: true, supportsStopAll: session.backgroundTasks.stopsTerminals }
    : undefined
}

function distinctTerminals(
  terminals: readonly CodexBackgroundTerminal[]
): CodexBackgroundTerminal[] {
  const byKey = new Map(
    terminals.map((terminal) => [JSON.stringify([terminal.threadId, terminal.processId]), terminal])
  )
  return [...byKey.values()]
}

/** A confirmed survivor takes precedence over request failures; cancelled means at least one stopped. */
export async function stopCodexBackgroundTasks(
  sessions: Map<string, CodexSession>,
  input: { sessionId: string; fence: number; taskIds: readonly string[] },
  timeoutMs: number | undefined
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const session = requireLiveCodexSession(sessions, input.sessionId)
  const { backgroundTasks } = session
  const subagents = backgroundTasks.subagentStopTargets(input.taskIds)
  // Turn interrupts leave child processes running, so stop their terminals too.
  const terminals = distinctTerminals([
    ...backgroundTasks.backgroundProcesses(input.taskIds),
    ...subagents.terminals
  ])
  const { acquisitionGeneration } = session
  const options = {
    timeoutMs: boundedTimeout(timeoutMs),
    isCurrent: () =>
      sessions.get(input.sessionId) === session &&
      !session.ended &&
      session.fence === input.fence &&
      session.acquisitionGeneration === acquisitionGeneration
  }
  const none: StopTally = { stopped: 0, survived: false }
  let failure: { error: unknown } | undefined
  const settle = (stop: Promise<StopTally>) =>
    stop.catch((error: unknown) => {
      failure ??= { error }
      return none
    })
  const children = subagents.turns.length
    ? await settle(
        interruptCodexSubagents(session, subagents.turns, {
          ...options,
          ended: ({ threadId, turnId }) => !backgroundTasks.runsSubagentTurn(threadId, turnId)
        })
      )
    : none
  // An app-server that is not answering is not asked again within the same Stop.
  const commands =
    terminals.length && !(failure?.error instanceof CodexAppServerTimeoutError)
      ? await settle(terminateCodexBackgroundTerminals(session.connection, terminals, options))
      : none
  const survived = children.survived || commands.survived
  if (failure && !survived) {
    throw failure.error
  }
  return {
    cancelled: children.stopped + commands.stopped > 0,
    ...(survived ? { stillRunning: true as const } : {})
  }
}
