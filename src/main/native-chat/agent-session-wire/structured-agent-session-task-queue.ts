import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'

export class StructuredAgentSessionTaskQueue {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly attaching = new Set<Promise<unknown>>()
  private readonly pendingLocations = new Map<
    Promise<unknown>,
    {
      sessionId: string
      location: AgentSessionExecutionLocation
    }
  >()

  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(this.chains, sessionId, task)
  }

  trackAttach<T>(
    operation: Promise<T>,
    pending?: { sessionId: string; location: AgentSessionExecutionLocation }
  ): Promise<T> {
    this.attaching.add(operation)
    if (pending) {
      this.pendingLocations.set(operation, pending)
    }
    void operation.then(
      () => this.finishAttach(operation),
      () => this.finishAttach(operation)
    )
    return operation
  }

  private finishAttach(operation: Promise<unknown>): void {
    this.attaching.delete(operation)
    this.pendingLocations.delete(operation)
  }

  pendingMembers(workspaceId: string, executionHostId: string): string[] {
    return [...this.pendingLocations.values()]
      .filter(
        ({ location }) =>
          location.workspaceId === workspaceId && location.executionHostId === executionHostId
      )
      .map(({ sessionId }) => sessionId)
  }

  hasPendingAttach(sessionId: string): boolean {
    return [...this.pendingLocations.values()].some((pending) => pending.sessionId === sessionId)
  }

  async drainAttaches(): Promise<void> {
    while (this.attaching.size > 0) {
      await Promise.allSettled(this.attaching)
    }
  }
}
