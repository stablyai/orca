import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionHandoffQueue } from './structured-agent-session-handoff-queue'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

export function queueStructuredHandoffAfterTurn(input: {
  callerKey: string
  params: AgentSessionHandoffRequest
  deps: StructuredAgentSessionHandoffDeps
  queue: StructuredAgentSessionHandoffQueue
  owner: (sessionId: string) => StructuredTuiOwner | undefined
  setStatus: (
    sessionId: string,
    status: Parameters<StructuredAgentSessionHandoffDeps['publish']>[1]
  ) => void
  begin: (callerKey: string, params: AgentSessionHandoffRequest, tuiAlreadyExited?: boolean) => void
}): void {
  const { callerKey, params, deps, queue, owner, setStatus, begin } = input
  const sessionId = params.envelope.sessionId
  let tuiReadiness: 'idle' | 'exited' | null = null
  setStatus(sessionId, {
    owner: params.direction === 'to-tui' ? 'native' : 'tui',
    direction: params.direction,
    phase: 'queued',
    stage: null,
    operationId: params.envelope.clientOperationId,
    hostLabel: deps.transport?.hostLabel
  })
  const tuiOwner = owner(sessionId)
  queue.enqueue(
    sessionId,
    async (signal) => {
      if (params.direction === 'to-tui') {
        return !activeStructuredAgentSessionTurnId(deps.session(sessionId).journal.snapshot().items)
      }
      tuiReadiness = tuiOwner
        ? ((await deps.transport?.waitForTuiIdleOrExit(tuiOwner, signal)) ?? null)
        : null
      return tuiReadiness !== null
    },
    () => begin(callerKey, { ...params, mode: 'now' }, tuiReadiness === 'exited')
  )
}
