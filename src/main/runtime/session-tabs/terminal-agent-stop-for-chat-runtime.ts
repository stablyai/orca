import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './structured-session-create-support'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { StopTerminalAgentForChatParams } from '../../../shared/rpc-contract/structured-agent-session-stop-terminal-params'
import type { AgentTransitionDetector } from '../../agent-hooks/agent-transition-detector'
import { stopTerminalAgentForChat } from './terminal-agent-stop-for-chat'
import { interruptWorkingAgent } from '../terminal-agent-interrupt'

export abstract class OrcaRuntimeWithStopTerminalAgentForChat extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  protected abstract readonly agentTransitions: Pick<
    AgentTransitionDetector,
    'latestRow' | 'subscribe'
  >

  async stopTerminalAgentForChat(
    input: z.infer<typeof StopTerminalAgentForChatParams>
  ): Promise<{ ok: true }> {
    const location = await this.resolveStructuredAgentSessionLocation(input.worktree)
    if (
      location.executionHostId !== 'local' ||
      location.wslDistro ||
      location.workspaceId !== input.cliSource.workspaceId
    ) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const readRow = () => this.agentTransitions.latestRow(input.cliSource.paneKey)
    const signal = AbortSignal.timeout(13_000)
    return stopTerminalAgentForChat({
      readRow,
      prepare: () => this.prepareTerminalAgentStopForChat(input, readRow, signal),
      predict: (prepared) =>
        this.resolveStructuredAgentSessionCreateIntent(
          {
            envelope: { sessionId: randomUUID(), clientOperationId: randomUUID() },
            worktree: input.worktree,
            agent: input.agent,
            resumeFrom: { providerSessionId: input.providerSessionId, cliSource: input.cliSource }
          },
          { source: input.cliSource, prepared }
        ),
      interrupt: (beforeWrite) =>
        interruptWorkingAgent(this, () => readRow(), input.cliSource.paneKey, {
          beforeWrite,
          signal: AbortSignal.timeout(3_000)
        }),
      subscribe: (changed) => this.agentTransitions.subscribe(changed)
    })
  }
}
