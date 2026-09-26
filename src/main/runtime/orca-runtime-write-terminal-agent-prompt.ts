// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import type { RuntimeTerminalPromptDelivery, RuntimeTerminalSend } from '../../shared/runtime-types'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './orca-runtime-core'
import {
  AGENT_PROMPT_SUBMIT,
  agentPromptSubmitJoinsPasteFrame,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../shared/agent-prompt-injection'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import { writeAgentPromptSubmitRetry } from './agent-prompt-submit-retry'
import {
  isTerminalSendSettlementAgent,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

export class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions = {}
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    const writeHostPlatform = this.getPtyWriteHostPlatform(ptyId)
    const pty = this.ptysById.get(ptyId)
    // OMP treats a large bracketed paste as a menu unless submit arrives in the same PTY write.
    // Once a foreground agent is known, it is the process that will consume the bytes;
    // launchAgent is only the fallback during startup before process detection settles.
    const submitWithPaste = agentPromptSubmitJoinsPasteFrame(
      pty?.foregroundAgent ?? pty?.launchAgent
    )
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    const renderGate = this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
    const waitTextCache: AgentPromptWaitTextCache = {}
    const preSubmitBaseline = submitWithPaste
      ? this.getAgentPromptActivity(handle, ptyId, waitTextCache)
      : undefined
    try {
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      await options.beforeWrite?.(ptyId)
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      this.assertAgentPromptPermissionSafe(
        permissionBaseline,
        this.getAgentPromptActivity(handle, ptyId)
      )
      // Keep the bracketed paste frame in one PTY write; Claude's composer can drop the
      // beginning when a large frame is split into independently processed chunks.
      renderGate?.arm()
      const initialWrite = submitWithPaste ? pastePayload + AGENT_PROMPT_SUBMIT : pastePayload
      if (!this.ptyController?.write(ptyId, initialWrite)) {
        throw new Error('terminal_not_writable')
      }
    } catch (error) {
      renderGate?.dispose()
      throw error
    }

    if (submitWithPaste) {
      // The Enter was part of the paste frame; waiting here would only delay receipt settlement.
      renderGate?.dispose()
    } else if (renderGate) {
      try {
        await waitForAgentPromptPromise(renderGate.wait(), options.signal)
      } finally {
        renderGate.dispose()
      }
    } else {
      const agent = this.getPtyAgent(ptyId)
      const submitDelayMs = options.promptForSchedule
        ? resolveAgentPromptSubmitDelayForAgent(writeHostPlatform, options.promptForSchedule, agent)
        : getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength)
      await waitForAgentPromptDelay(submitDelayMs, options.signal)
    }
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    if (!submitWithPaste) {
      try {
        await options.beforeWrite?.(ptyId)
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
    }
    const baseline = preSubmitBaseline ?? this.getAgentPromptActivity(handle, ptyId, waitTextCache)
    this.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
    if (!submitWithPaste) {
      if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
    }
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId))
    const queued = Boolean(options.acceptQueued && options.requestId)
    const binding = queued ? this.getTerminalPromptRequestBinding(handle) : null
    const foregroundAgent = this.ptysById.get(ptyId)?.foregroundAgent
    const launchAgent = this.ptysById.get(ptyId)?.launchAgent
    const settlementAgent = isTerminalSendSettlementAgent(foregroundAgent)
      ? foregroundAgent
      : isTerminalSendSettlementAgent(launchAgent)
        ? launchAgent
        : null
    const inputAccepted: RuntimeTerminalPromptDelivery | undefined = binding
      ? {
          requestId: options.requestId,
          stages: ['input_accepted'],
          provider: settlementAgent ?? 'unsupported',
          observation: settlementAgent ? 'supported' : 'unsupported',
          processIncarnation: binding.processIncarnation,
          generation,
          baselineWorkingSequence: baseline.workingSequence,
          baselineExplicitWorkingStartedAt: baseline.explicitWorkingStartedAt,
          baselinePermissionSequence: baseline.permissionSequence
        }
      : undefined
    if (inputAccepted) {
      const checkpoint: RuntimeTerminalSend = {
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(pastePayload, 'utf8') + 1,
        prompt: inputAccepted
      }
      // The prompt is in the pane now, so record its receipt without waiting out the retry delay.
      options.onInputAccepted?.(checkpoint)
      if (settlementAgent) {
        this.registerAgentPromptRequest(
          ptyId,
          generation,
          options.requestId,
          baseline.workingSequence,
          baseline.explicitWorkingStartedAt
        )
      }
    }
    const retried =
      !submitWithPaste &&
      (await writeAgentPromptSubmitRetry({
        agent: foregroundAgent ?? launchAgent,
        signal: options.signal,
        assertWritable: async () => {
          assertAgentPromptRequestActive(options.signal)
          this.assertAgentPromptGeneration(ptyId, generation)
          await options.beforeWrite?.(ptyId)
          assertAgentPromptRequestActive(options.signal)
          this.assertAgentPromptGeneration(ptyId, generation)
          this.assertAgentPromptPermissionSafe(
            permissionBaseline,
            this.getAgentPromptActivity(handle, ptyId)
          )
        },
        write: (data) => this.ptyController?.write(ptyId, data) === true
      }))
    const submits = retried ? 2 : 1
    if (!inputAccepted) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        timeoutMs: effectTimeoutMs,
        signal: options.signal
      })
      return { submits }
    }
    // Providers without a lifecycle verifier still get an honest accepted
    // receipt; they must not fail a Dispatch merely because Orca cannot prove
    // submission through hooks.
    if (!settlementAgent) {
      return { submits, prompt: inputAccepted }
    }
    try {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        acceptTurnStart: (evidence) =>
          this.acceptAgentPromptTurnStart(
            ptyId,
            generation,
            options.requestId!,
            baseline.workingSequence,
            baseline.explicitWorkingStartedAt,
            evidence
          ),
        allowOutputEvidence: false,
        signal: options.signal,
        timeoutMs: options.observationTimeoutMs ?? effectTimeoutMs
      })
      this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
      return {
        submits,
        prompt: {
          ...inputAccepted,
          stages: ['input_accepted', 'turn_started']
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return { submits, prompt: inputAccepted }
      }
      // The input was accepted; a reset during the retry wait is the observation stage's to judge.
      if (error instanceof Error && error.message === 'terminal_handle_stale') {
        this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
        return { submits, prompt: inputAccepted }
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
        return {
          submits,
          prompt: { ...inputAccepted, observation: 'permission' }
        }
      }
      throw error
    }
  }
}
