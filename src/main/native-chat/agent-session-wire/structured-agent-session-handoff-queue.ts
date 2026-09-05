import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffStatus
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

export class StructuredAgentSessionHandoffQueue {
  private readonly controllers = new Map<string, AbortController>()

  cancel(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId)
    controller?.abort()
    this.controllers.delete(sessionId)
    return controller !== undefined
  }

  enqueue(
    sessionId: string,
    isIdle: (signal: AbortSignal) => boolean | Promise<boolean>,
    onReady: () => void
  ): void {
    this.cancel(sessionId)
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    void this.waitUntilIdle(sessionId, controller, isIdle).then((ready) => {
      if (ready) {
        onReady()
      }
    })
  }

  private async waitUntilIdle(
    sessionId: string,
    controller: AbortController,
    isIdle: (signal: AbortSignal) => boolean | Promise<boolean>
  ): Promise<boolean> {
    while (this.controllers.get(sessionId) === controller && !controller.signal.aborted) {
      try {
        if (await isIdle(controller.signal)) {
          this.controllers.delete(sessionId)
          return true
        }
      } catch {
        if (controller.signal.aborted) {
          return false
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return false
  }
}

export function queuedStructuredHandoffCanBegin(
  record: AgentSessionRecord,
  status: AgentSessionHandoffStatus,
  params: AgentSessionHandoffRequest
): boolean {
  const expectedOwner = params.direction === 'to-tui' ? 'native' : 'tui'
  return (
    record.sessionId === params.envelope.sessionId &&
    status.phase === 'queued' &&
    status.direction === params.direction &&
    status.operationId === params.envelope.clientOperationId &&
    record.lease.runtimeFence === params.envelope.expectedRuntimeFence &&
    record.lease.runtimeKind === expectedOwner &&
    record.lease.claimStatus === 'live' &&
    record.lease.handoffStage === null &&
    !record.lease.unreconciled
  )
}

export function enqueueStructuredHandoffAfterTurn(input: {
  deps: StructuredAgentSessionHandoffDeps
  queue: StructuredAgentSessionHandoffQueue
  params: AgentSessionHandoffRequest
  tuiOwner: StructuredTuiOwner | undefined
  status: () => AgentSessionHandoffStatus
  requireRecord: () => AgentSessionRecord
  setStatus: (status: AgentSessionHandoffStatus) => void
  begin: (params: AgentSessionHandoffRequest, tuiAlreadyExited: boolean) => void
  refuse: (record: AgentSessionRecord) => void
}): void {
  const { deps, params, queue, tuiOwner } = input
  const sessionId = params.envelope.sessionId
  let tuiReadiness: 'idle' | 'exited' | null = null
  let observedTuiQueue = false
  input.setStatus({
    owner: params.direction === 'to-tui' ? 'native' : 'tui',
    direction: params.direction,
    phase: 'queued',
    stage: null,
    operationId: params.envelope.clientOperationId,
    hostLabel: deps.transport?.hostLabel
  })
  queue.enqueue(
    sessionId,
    async (signal) => {
      if (params.direction === 'to-tui') {
        return !activeStructuredAgentSessionTurnId(deps.session(sessionId).journal.snapshot().items)
      }
      if (!observedTuiQueue) {
        observedTuiQueue = true
        return false
      }
      tuiReadiness = tuiOwner
        ? ((await deps.transport?.waitForTuiIdleOrExit(tuiOwner, signal)) ?? null)
        : null
      if (tuiReadiness === 'exited') {
        return true
      }
      if (!activeStructuredAgentSessionTurnId(deps.session(sessionId).journal.snapshot().items)) {
        tuiReadiness = 'idle'
        return true
      }
      return false
    },
    () => {
      const record = input.requireRecord()
      const status = input.status()
      if (!queuedStructuredHandoffCanBegin(record, status, params)) {
        input.refuse(record)
        return
      }
      input.begin(params, tuiReadiness === 'exited')
    }
  )
}
