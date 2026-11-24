import { useMemo } from 'react'
import type { StructuredAgentSessionState } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import {
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionHostSaysWorking
} from '../../../../../src/shared/agent-session/view/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../../../src/shared/agent-session/view/structured-agent-session-main-agent-working'

export function mobileStructuredAgentSessionWorking(
  state: Pick<
    StructuredAgentSessionState,
    'working' | 'latestTurn' | 'items' | 'submissions' | 'fence'
  >
): boolean {
  return structuredAgentSessionHostSaysWorking(state.working, () =>
    isStructuredAgentSessionMainAgentWorking(
      runningStructuredAgentSessionTurnId(state),
      state.submissions,
      state.fence
    )
  )
}

export function useMobileStructuredSessionWork({
  working,
  latestTurn,
  items,
  submissions,
  fence
}: Parameters<typeof mobileStructuredAgentSessionWorking>[0]) {
  const turnId = useMemo(
    () => runningStructuredAgentSessionTurnId({ items, latestTurn }),
    [items, latestTurn]
  )
  const isWorking = useMemo(
    () =>
      structuredAgentSessionHostSaysWorking(working, () =>
        isStructuredAgentSessionMainAgentWorking(turnId, submissions, fence)
      ),
    [working, turnId, submissions, fence]
  )
  return { isWorking, turnId }
}
