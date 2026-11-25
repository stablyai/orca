import { OrcaRuntimeWithHookSilentSendGuard } from './terminal-hook-silent-send-guard'
import type { RuntimeTerminalPromptDelivery } from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type {
  AgentPromptTurnStartEvidence,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { verifyAgentPromptSubmission } from './agent-prompt-submission-verification'
import { AgentPromptRequestCorrelation } from './agent-prompt-request-correlation'
import {
  readAgentPromptAftermath,
  type AgentPromptAftermath,
  type AgentStatusReport
} from './agent-prompt-aftermath'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from '../../workspaces/process-listing/runtime-worktree-status-projection'

export abstract class OrcaRuntimeWithAgentPromptRequestCorrelation extends OrcaRuntimeWithHookSilentSendGuard {
  private readonly agentPromptCorrelation = new AgentPromptRequestCorrelation()

  getTerminalPromptRequestBinding(handle: string): {
    ptyId: string
    processIncarnation: string
    generation: number
  } {
    const live = this.getLivePtyForHandle(handle)
    const ptyId = live?.pty.ptyId ?? this.getLiveLeafForHandle(handle).leaf.ptyId
    if (!ptyId) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const incarnationId = live?.pty.incarnationId ?? this.ptysById.get(ptyId)?.incarnationId
    return {
      ptyId,
      processIncarnation: incarnationId ?? `${this.runtimeId}:${ptyId}:${generation}`,
      generation
    }
  }

  async observeTerminalAgentPrompt(
    handle: string,
    prompt: RuntimeTerminalPromptDelivery,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeTerminalPromptDelivery> {
    const binding = this.getTerminalPromptRequestBinding(handle)
    if (
      binding.processIncarnation !== prompt.processIncarnation ||
      binding.generation !== prompt.generation
    ) {
      return { ...prompt, observation: 'incarnation_replaced' }
    }
    const waitTextCache: AgentPromptWaitTextCache = {}
    const baseline = this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache)
    try {
      await verifyAgentPromptSubmission({
        baseline: {
          ...baseline,
          workingSequence: prompt.baselineWorkingSequence,
          ...(prompt.baselinePermissionSequence !== undefined
            ? { permissionSequence: prompt.baselinePermissionSequence }
            : {}),
          ...(prompt.baselineExplicitWorkingStartedAt !== undefined
            ? { explicitWorkingStartedAt: prompt.baselineExplicitWorkingStartedAt }
            : {})
        },
        readActivity: () => this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache),
        acceptTurnStart: (evidence) =>
          this.acceptAgentPromptTurnStart(
            binding.ptyId,
            binding.generation,
            prompt.requestId,
            prompt.baselineWorkingSequence,
            prompt.baselineExplicitWorkingStartedAt ?? null,
            evidence
          ),
        // Old hosts omit the hook baseline, so their receipts retain title-only observation.
        allowHookEvidence: prompt.baselineExplicitWorkingStartedAt !== undefined,
        allowOutputEvidence: false,
        signal,
        timeoutMs
      })
      this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
      return { ...prompt, stages: ['input_accepted', 'turn_started'], observation: 'supported' }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return prompt
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
        return { ...prompt, observation: 'permission' }
      }
      throw error
    }
  }

  /** One read of what followed `prompt` in its terminal; null when the handle no longer resolves. */
  readTerminalAgentPromptAftermath(
    handle: string,
    prompt: RuntimeTerminalPromptDelivery
  ): AgentPromptAftermath | null {
    try {
      const binding = this.getTerminalPromptRequestBinding(handle)
      if (binding.processIncarnation !== prompt.processIncarnation) {
        return { processReplaced: true }
      }
      return readAgentPromptAftermath(
        prompt,
        this.getAgentPromptActivity(handle, binding.ptyId),
        this.readLastAgentStatusReport(handle, binding.ptyId)
      )
    } catch {
      return null
    }
  }

  /** The newer of the agent's hook status and the status it printed into its own terminal. */
  private readLastAgentStatusReport(handle: string, ptyId: string): AgentStatusReport | null {
    const hook = this.getFreshExplicitAgentStatusForHandle(handle, ptyId)
    const printed = this.ptysById.get(ptyId)?.lastExplicitAgentStatus
    if (printed && (!hook || printed.updatedAt > hook.updatedAt)) {
      return {
        status: mapExplicitAgentStateToRuntimeTerminalStatus(printed.state),
        at: printed.updatedAt
      }
    }
    return hook ? { status: hook.status, at: hook.updatedAt } : null
  }

  protected registerAgentPromptRequest(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null
  ): void {
    this.agentPromptCorrelation.register(ptyId, {
      generation,
      requestId,
      baselineWorkingSequence,
      baselineExplicitWorkingStartedAt
    })
  }

  protected forgetAgentPromptRequest(ptyId: string, generation: number, requestId: string): void {
    this.agentPromptCorrelation.forget(ptyId, generation, requestId)
  }

  protected acceptAgentPromptTurnStart(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null,
    evidence: AgentPromptTurnStartEvidence
  ): boolean {
    return this.agentPromptCorrelation.acceptTurnStart(
      ptyId,
      generation,
      requestId,
      baselineWorkingSequence,
      baselineExplicitWorkingStartedAt,
      evidence
    )
  }

  protected clearAgentPromptCorrelationForPty(ptyId: string): void {
    this.agentPromptCorrelation.clearForPty(ptyId)
  }
}
