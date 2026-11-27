import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'

/** Its lead turn runs, a send is owed or its goal continues, and no person is being asked. */
export function chatTurnRunning(
  state: Pick<
    StructuredAgentSessionStatusState,
    'latestRequest' | 'owesWork' | 'goalContinues' | 'pendingPromptIds' | 'summary'
  >
): boolean {
  // A goal paused on an open async question waits on the person, like a prompt.
  const goalContinues = state.goalContinues === true && !state.summary.openAsyncQuestion
  return (
    (state.latestRequest?.turnState === 'running' || state.owesWork || goalContinues) &&
    state.pendingPromptIds.length === 0
  )
}

/** Its lead turn stopped because a person is being asked: it waits on a person, it has not
 *  finished, so a question it holds is still its to answer. Unreadable → false. */
export function chatAwaitingPerson(
  state: Pick<StructuredAgentSessionStatusState, 'pendingPromptIds'>
): boolean {
  return state.pendingPromptIds.length > 0
}

/** A chat's status as its journal stands now; null when the chat isn't loaded here. */
export type ChatStateReader = (
  sessionId: string
) => Promise<StructuredAgentSessionStatusState | null>
