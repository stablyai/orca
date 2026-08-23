import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import { registerAdoptedStructuredTuiOwner } from './structured-adopted-tui-owner'
import { idleStructuredHandoffStatus } from './structured-agent-session-handoff-status'
import type { StructuredTuiOwner } from './structured-agent-session-handoff-types'

export class StructuredAgentSessionHandoffState {
  private readonly statuses = new Map<string, AgentSessionHandoffStatus>()
  private readonly tuiOwners = new Map<string, StructuredTuiOwner>()

  constructor(
    private readonly deps: {
      requireRecord: (sessionId: string) => AgentSessionRecord
      publish: (sessionId: string, status: AgentSessionHandoffStatus) => void
      hostLabel?: string
    }
  ) {}

  status = (sessionId: string): AgentSessionHandoffStatus =>
    this.statuses.get(sessionId) ?? idleStructuredHandoffStatus(this.deps.requireRecord(sessionId))

  cachedStatus = (sessionId: string): AgentSessionHandoffStatus | undefined =>
    this.statuses.get(sessionId)

  owner = (sessionId: string): StructuredTuiOwner | undefined => this.tuiOwners.get(sessionId)

  retainOwner = (sessionId: string, owner: StructuredTuiOwner): void => {
    this.tuiOwners.set(sessionId, owner)
  }

  releaseOwner = (sessionId: string): void => void this.tuiOwners.delete(sessionId)

  setStatus = (sessionId: string, status: AgentSessionHandoffStatus): void => {
    this.statuses.set(sessionId, status)
    this.deps.publish(sessionId, status)
  }

  adoptTuiOwner = (sessionId: string, owner: StructuredTuiOwner): void =>
    registerAdoptedStructuredTuiOwner({
      record: this.deps.requireRecord(sessionId),
      owner,
      hostLabel: this.deps.hostLabel,
      retain: () => this.retainOwner(sessionId, owner),
      publish: (status) => this.setStatus(sessionId, status)
    })
}
