import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { PROVIDER_COMPACTING_ACTIVITY } from '../native-chat/agent-session-wire/provider-frame-activity'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { PiRpcContextUsage } from './rpc-context-usage'
import type { PiRpcSession } from './rpc-session'

/** Pi compacting its context: what the chat shows, and the wait a send needs meanwhile. */
export class PiRpcCompaction {
  private current?: PromiseWithResolvers<void>
  constructor(private readonly context: PiRpcContextUsage) {}

  get running(): boolean {
    return this.current !== undefined
  }

  start(): ProviderTimelineEvent[] {
    this.current ??= Promise.withResolvers()
    return [...this.context.compacting(), { type: 'activity', text: PROVIDER_COMPACTING_ACTIVITY }]
  }

  end(result?: unknown): ProviderTimelineEvent[] {
    this.release()
    this.context.compacted(result)
    return [{ type: 'activity', text: null }]
  }

  /** Pi refuses prompts during a requested compaction; like Pi's own TUI, sends wait for any. */
  async waitForEnd(signal?: AbortSignal): Promise<void> {
    while (this.current) {
      await waitForPromiseWithSignal(this.current.promise, signal)
    }
  }

  /** Lets waiting sends go when the session ends mid-compaction. */
  release(): void {
    this.current?.resolve()
    this.current = undefined
  }
}

export async function compactPiRpcSession(
  session: PiRpcSession,
  command: StructuredAgentSessionCommandRun
): Promise<AgentSessionCommandAdmission> {
  session.turns.beginCommand(command)
  try {
    await session.connection.request(
      'compact',
      command.instructions ? { customInstructions: command.instructions } : {},
      { timeoutMs: null }
    )
    session.turns.commandCompleted()
    return { state: 'accepted', providerIdentity: null }
  } catch (error) {
    if (!(error instanceof JsonlRpcResponseError)) {
      throw error
    }
    if (error.message === 'Nothing to compact (session too small)') {
      session.lane.apply([
        {
          type: 'item.close',
          item: `compact-noop:${command.turnId}`,
          body: { kind: 'status', tone: 'warning', text: error.message }
        }
      ])
      session.turns.commandCompleted()
      return { state: 'accepted', providerIdentity: null }
    }
    session.turns.commandRejected()
    return {
      state: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('providerRejected', {
          detail: providerDiagnostic(error.message, 'person')
        }),
        { agentName: session.agentName, surface: 'rejection' }
      )
    }
  }
}
