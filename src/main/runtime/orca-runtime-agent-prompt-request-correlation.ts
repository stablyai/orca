import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import type { RuntimeTerminalPromptDelivery } from '../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import type {
  AgentPromptTurnStartEvidence,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import {
  isTerminalSendSettlementAgent,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import type { TuiAgent } from '../../shared/tui-agent'
import { AgentPromptRequestCorrelation } from './agent-prompt-request-correlation'
import type { LaunchedAgentForeground } from './launched-agent-foreground'
import {
  observeLaunchTurnStart,
  type LaunchTurnStartVerdict
} from './launch-turn-start-observation'
import { readFreshComposerHold } from './launched-agent-composer-readiness'

export class OrcaRuntimeWithAgentPromptRequestCorrelation extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  private readonly agentPromptCorrelation = new AgentPromptRequestCorrelation()
  // Declared, not defined: both live further up the mixin chain, so this link cannot see them.
  declare protected getLivePtyForHandle: (
    handle: string
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  declare protected getLiveLeafForHandle: (handle: string) => {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  declare readLaunchedAgentForeground: (
    ptyId: string,
    agent: TuiAgent
  ) => Promise<LaunchedAgentForeground>

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

  /**
   * Whether a prompt that rode an agent's launch command line started a turn. The hook proof counts
   * only an event that carried an explicit prompt after `launchStartedAt`: a spinner title, a
   * prompt-less SessionStart or output bytes prove nothing about the prompt. Where hooks cannot give
   * that proof, or never reach the pane, the launch's own evidence decides (`observeLaunchTurnStart`).
   */
  async observeTerminalLaunchTurnStart(
    handle: string,
    launch: { launchStartedAt: number; agent: TuiAgent | null },
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<LaunchTurnStartVerdict> {
    const { ptyId } = this.getTerminalPromptRequestBinding(handle)
    const agent = launch.agent
    const hooksProveTurn =
      isTerminalSendSettlementAgent(agent) &&
      this.store?.getSettings().agentStatusHooksEnabled !== false
    return observeLaunchTurnStart(
      {
        ...(hooksProveTurn
          ? {
              observeHookTurn: (stop) =>
                this.observeLaunchHookTurn(handle, ptyId, launch.launchStartedAt, timeoutMs, stop)
            }
          : {}),
        hookReachedPane: () => this.getFreshExplicitAgentStatusForPty(handle, ptyId) !== null,
        readWorkingSequence: () => this.getAgentPromptActivity(handle, ptyId).workingSequence,
        dialogOnScreen: () =>
          readFreshComposerHold(
            this.getTerminalAgentStatusSnapshot(handle, ptyId).waitText,
            this.readLiveTerminalScreenLines(ptyId)
          ) === 'dialog',
        launchRecorded: () => Boolean(this.ptysById.get(ptyId)?.launchAgent),
        readForeground: async () =>
          agent ? await this.readLaunchedAgentForeground(ptyId, agent) : 'unknown'
      },
      { launchStartedAt: launch.launchStartedAt, timeoutMs, ...(signal ? { signal } : {}) }
    )
  }

  private async observeLaunchHookTurn(
    handle: string,
    ptyId: string,
    launchStartedAt: number,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<'observed' | 'permission' | 'unobserved'> {
    try {
      await verifyAgentPromptSubmission({
        baseline: {
          ...this.getAgentPromptActivity(handle, ptyId),
          explicitPromptStartedAt: launchStartedAt
        },
        readActivity: () => this.getAgentPromptActivity(handle, ptyId),
        explicitPromptOnly: true,
        signal,
        timeoutMs
      })
      return 'observed'
    } catch (error) {
      return error instanceof Error && error.message === 'agent_prompt_blocked'
        ? 'permission'
        : 'unobserved'
    }
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
