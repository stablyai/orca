import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import {
  createStructuredHandoffFlowContext,
  requireStructuredHandoffRecord
} from './structured-agent-session-handoff-flow-context'
import { restoreStructuredAgentSessionHandoff } from './structured-agent-session-handoff-restart'
import { closeRetainedTuiOwner } from './structured-agent-session-handoff-owner-close'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredAgentSessionHandoffFlowContext
} from './structured-agent-session-handoff-types'
import { StructuredAgentSessionHandoffState } from './structured-agent-session-handoff-state'

export class StructuredAgentSessionHandoffCoordinator {
  private readonly state: StructuredAgentSessionHandoffState

  constructor(private readonly deps: StructuredAgentSessionHandoffDeps) {
    // oxfmt-ignore
    this.state = new StructuredAgentSessionHandoffState({ requireRecord: (sessionId) => this.requireRecord(sessionId), publish: deps.publish, hostLabel: deps.transport?.hostLabel })
  }

  status = (sessionId: string) => this.state.status(sessionId)

  closeRetainedTuiOwner = (sessionId: string): Promise<boolean> =>
    closeRetainedTuiOwner({
      sessionId,
      deps: this.deps,
      owner: this.state.owner,
      requireRecord: this.requireRecord,
      releaseOwner: this.state.releaseOwner
    })

  setStatus = (sessionId: string, status: AgentSessionHandoffStatus): void =>
    this.state.setStatus(sessionId, status)

  async restore(sessionId: string): Promise<void> {
    await restoreStructuredAgentSessionHandoff(
      {
        deps: this.deps,
        requireRecord: (id) => this.requireRecord(id),
        flowContext: () => this.flowContext(),
        retainOwner: this.state.retainOwner,
        setStatus: this.state.setStatus
      },
      sessionId
    )
  }

  private flowContext(): StructuredAgentSessionHandoffFlowContext {
    return createStructuredHandoffFlowContext({
      deps: this.deps,
      owner: this.state.owner,
      retainOwner: this.state.retainOwner,
      releaseOwner: this.state.releaseOwner,
      setStatus: this.state.setStatus,
      requireRecord: (sessionId) => this.requireRecord(sessionId)
    })
  }

  private requireRecord = (sessionId: string): AgentSessionRecord =>
    requireStructuredHandoffRecord(this.deps, sessionId)
}
