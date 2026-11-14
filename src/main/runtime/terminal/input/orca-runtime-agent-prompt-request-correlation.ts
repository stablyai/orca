import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './terminal-agent-status-and-submission'
import type { RuntimeTerminalPromptDelivery } from '../../../../shared/runtime-terminal-send-contract'
import type {
  AgentPromptTurnStartEvidence,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { verifyAgentPromptSubmission } from './agent-prompt-submission-verification'
import {
  AgentPromptRequestCorrelation,
  type AgentPromptOperation
} from './agent-prompt-request-correlation'
import type { TerminalCommandBoundary } from './terminal-command-paint'

export abstract class OrcaRuntimeWithAgentPromptRequestCorrelation extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  private readonly agentPromptCorrelation = new AgentPromptRequestCorrelation()

  protected beginAgentPromptOperation(ptyId: string, generation: number, requestId?: string) {
    const pty = this.ptysById.get(ptyId)
    const controller = this.ptyController
    const incarnation = pty?.incarnationId
    const connection = pty?.connectionId
    const provider = pty?.providerGenerationResetAtEpochMs
    const paint = pty?.commandPaint
    const expectedEpoch = (paint?.commandEpoch ?? 0) + 1
    const pendingCommitted = paint?.capturePendingCommandStart()
    const bindingIsCurrent = () =>
      this.ptysById.get(ptyId) === pty &&
      this.ptyController === controller &&
      pty?.incarnationId === incarnation &&
      pty?.connectionId === connection &&
      pty?.providerGenerationResetAtEpochMs === provider
    const operation = this.agentPromptCorrelation.begin(
      ptyId,
      generation,
      requestId,
      pendingCommitted
        ? (boundary) =>
            boundary.paint === paint &&
            boundary.paint.commandEpoch === expectedEpoch &&
            pendingCommitted()
        : undefined,
      bindingIsCurrent
    )
    return {
      operation,
      isCurrent: () => operation.phase !== 'retired' && bindingIsCurrent(),
      acceptBaseline: (baseline: {
        workingSequence: number
        explicitWorkingStartedAt: number | null
      }) =>
        this.agentPromptCorrelation.acceptBaseline(operation, {
          baselineWorkingSequence: baseline.workingSequence,
          baselineExplicitWorkingStartedAt: baseline.explicitWorkingStartedAt
        }),
      forget: () => this.agentPromptCorrelation.forget(ptyId, operation)
    }
  }

  protected retireAgentPromptOperationsForBoundary(
    ptyId: string,
    boundary: TerminalCommandBoundary
  ): void {
    this.agentPromptCorrelation.retireForBoundary(ptyId, boundary)
  }

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
    const operation = this.agentPromptCorrelation.find(
      binding.ptyId,
      binding.generation,
      prompt.requestId,
      {
        baselineWorkingSequence: prompt.baselineWorkingSequence,
        baselineExplicitWorkingStartedAt: prompt.baselineExplicitWorkingStartedAt ?? null
      }
    )
    if (!operation) {
      return prompt
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
          this.acceptAgentPromptTurnStart(binding.ptyId, operation, evidence),
        // Old hosts omit the hook baseline, so their receipts retain title-only observation.
        allowHookEvidence: prompt.baselineExplicitWorkingStartedAt !== undefined,
        allowOutputEvidence: false,
        signal,
        timeoutMs
      })
      this.agentPromptCorrelation.forget(binding.ptyId, operation)
      return { ...prompt, stages: ['input_accepted', 'turn_started'], observation: 'supported' }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return prompt
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.agentPromptCorrelation.forget(binding.ptyId, operation)
        return { ...prompt, observation: 'permission' }
      }
      throw error
    }
  }

  protected acceptAgentPromptTurnStart(
    ptyId: string,
    operation: AgentPromptOperation,
    evidence: AgentPromptTurnStartEvidence
  ): boolean {
    return this.agentPromptCorrelation.acceptTurnStart(ptyId, operation, evidence)
  }

  protected clearAgentPromptCorrelationForPty(ptyId: string): void {
    this.agentPromptCorrelation.clearForPty(ptyId)
  }
}
