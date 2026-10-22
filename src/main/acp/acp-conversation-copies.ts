import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { copyAcpConversation } from './acp-conversation-copy'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

/** Copy children have their own cleanup lifecycle; they never gate the original chat's start. */
export class AcpConversationCopies {
  private readonly children = new ProviderAcquisitionStarts<AcpStructuredConnection>()
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {}

  copy: NonNullable<StructuredAgentSessionAdapter['copyConversation']> = async (input) => {
    // A copy runs the agent too, so it is fenced like a chat start.
    const gate = this.deps.spec.launchGate?.enter(this.shutdown.signal)
    const copy = copyAcpConversation(this.deps, input, {
      signal: gate?.signal ?? this.shutdown.signal,
      track: (connection) => {
        this.children.retainFailed(randomUUID(), connection)
        this.deps.spec.launchGate?.retain(connection)
      }
    })
    this.pending.add(copy)
    try {
      return await copy
    } finally {
      this.pending.delete(copy)
      gate?.leave()
    }
  }

  async closeAll(): Promise<boolean> {
    this.shutdown.abort()
    await Promise.allSettled(this.pending)
    const closed = await Promise.all(
      this.children.failedSessionIds().map((id) => this.children.stopFailed(id))
    )
    return closed.every(Boolean)
  }
}
