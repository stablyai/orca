import type {
  AgentPromptExpectedBinding,
  RuntimeAgentPromptWriteOptions
} from '../../runtime-terminal-contracts'
import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from '../../orca-runtime-core'
import {
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  AGENT_PROMPT_SUBMIT,
  agentPromptSubmitJoinsPasteFrame,
  getAgentPromptHeldSubmitBudgetMs,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../../../shared/agent-prompt-injection'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from '../../agent-prompt-submission-verification'
import {
  isTerminalSendSettlementAgent,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from '../../agent-prompt-submission-verification'
import { AgentPromptPermissionReturnedError } from './agent-prompt-permission-hold'
import { OrcaRuntimeWithResubmitHeldAgentPrompt } from './terminal-agent-prompt-resubmit'

export abstract class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResubmitHeldAgentPrompt {
  protected abstract createAgentPromptRenderGate(
    ptyId: string,
    pasteIngestMs: number
  ): { arm: () => void; wait: () => Promise<void>; dispose: () => void } | null

  protected assertAgentPromptExpectedBinding(
    handle: string,
    expected: AgentPromptExpectedBinding | undefined
  ): void {
    if (!expected) {
      return
    }
    const current = this.getTerminalPromptRequestBinding(handle)
    if (
      current.ptyId !== expected.ptyId ||
      current.processIncarnation !== expected.processIncarnation
    ) {
      throw new Error('terminal_handle_stale')
    }
  }

  /** Under `wait`, a pre-paste refusal is the hold's to resume rather than the caller's to see. */
  private throwIfAgentPromptPermissionReturned(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (this.isAgentPromptPermissionBlocked(baseline, current)) {
      throw new AgentPromptPermissionReturnedError()
    }
  }

  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    if (options.onPermission === 'wait') {
      this.throwIfAgentPromptPermissionReturned(permissionBaseline, permissionBaseline)
    }
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    const writeHostPlatform = this.getPtyWriteHostPlatform(ptyId)
    const pty = this.ptysById.get(ptyId)
    // OMP needs paste and submit in one write; the foreground consumer wins, with launchAgent only a startup fallback.
    const submitWithPaste = agentPromptSubmitJoinsPasteFrame(
      pty?.foregroundAgent ?? pty?.launchAgent
    )
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    // A ready Claude composer never settles this gate, adding its full 8s cap; desktop paste submits in about 2s.
    const renderGate = options.composerReady
      ? null
      : this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
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
      this.assertAgentPromptExpectedBinding(handle, options.expectedBinding)
      if (options.onPermission === 'wait') {
        this.throwIfAgentPromptPermissionReturned(
          permissionBaseline,
          this.getAgentPromptActivity(handle, ptyId)
        )
      }
      this.assertAgentPromptPermissionSafe(
        permissionBaseline,
        this.getAgentPromptActivity(handle, ptyId)
      )
      // Claude can lose the start of a large bracketed paste split across writes; send the whole frame together.
      renderGate?.arm()
      const initialWrite = submitWithPaste ? pastePayload + AGENT_PROMPT_SUBMIT : pastePayload
      if (!this.ptyController?.write(ptyId, initialWrite, options.inputKind)) {
        throw new Error('terminal_not_writable')
      }
      if (submitWithPaste) {
        options.onSubmitWritten?.()
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
    } else if (options.composerReady) {
      await waitForAgentPromptDelay(
        AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + pasteIngestMs,
        options.signal
      )
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
      if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      options.onSubmitWritten?.()
    }
    const submits = submitWithPaste
      ? 1
      : 1 +
        (await this.resubmitHeldAgentPrompt(ptyId, generation, options, {
          baseline,
          readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
          prompt: options.promptForSchedule,
          heldBudgetMs: getAgentPromptHeldSubmitBudgetMs(
            writeHostPlatform,
            this.getPtyAgent(ptyId),
            pastePayload
          )
        }))
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId))
    if (!options.acceptQueued || !options.requestId) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        timeoutMs: effectTimeoutMs,
        signal: options.signal
      })
      return { submits }
    }
    const binding = this.getTerminalPromptRequestBinding(handle)
    const foregroundAgent = this.ptysById.get(ptyId)?.foregroundAgent
    const launchAgent = this.ptysById.get(ptyId)?.launchAgent
    const settlementAgent = isTerminalSendSettlementAgent(foregroundAgent)
      ? foregroundAgent
      : isTerminalSendSettlementAgent(launchAgent)
        ? launchAgent
        : null
    const inputAccepted: RuntimeTerminalPromptDelivery = {
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
    const checkpoint: RuntimeTerminalSend = {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(pastePayload, 'utf8') + submits,
      prompt: inputAccepted
    }
    options.onInputAccepted?.(checkpoint)
    // Without a lifecycle verifier, report accepted input; inability to prove submission must not fail Dispatch.
    if (!settlementAgent) {
      return { submits, prompt: inputAccepted }
    }
    this.registerAgentPromptRequest(
      ptyId,
      generation,
      options.requestId,
      baseline.workingSequence,
      baseline.explicitWorkingStartedAt
    )
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
