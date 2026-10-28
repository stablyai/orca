import { agentPromptObservationSignal } from './agent-prompt-signals'
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
    const observationSignal = agentPromptObservationSignal(options)
    assertAgentPromptRequestActive(observationSignal)
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
    const incarnationId = pty?.incarnationId
    const lifecycleSignal = this.getPtyLifecycleSignal(ptyId)
    const deliverySignal = options.signal
      ? AbortSignal.any([options.signal, lifecycleSignal])
      : lifecycleSignal
    const admissionSignal = observationSignal
      ? AbortSignal.any([observationSignal, deliverySignal])
      : deliverySignal
    const assertWritable = (signal: AbortSignal): void => {
      assertAgentPromptRequestActive(signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      if (incarnationId != null && this.ptysById.get(ptyId)?.incarnationId !== incarnationId) {
        throw new Error('terminal_handle_stale')
      }
      this.assertAgentPromptExpectedBinding(handle, options.expectedBinding)
      if (this.isPtyStopRequested(ptyId)) {
        throw new Error('terminal_not_writable')
      }
    }
    const beforeWrite = async (signal: AbortSignal): Promise<void> => {
      assertWritable(signal)
      await waitForAgentPromptPromise(
        Promise.resolve().then(() => {
          assertWritable(signal)
          return options.beforeWrite?.(ptyId)
        }),
        signal
      )
      assertWritable(signal)
    }
    let baseline: AgentPromptActivity
    try {
      await beforeWrite(admissionSignal)
      assertWritable(admissionSignal)
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
      if (!submitWithPaste) {
        // Once paste is accepted, only host cancellation can suppress its first Enter.
        if (renderGate) {
          await waitForAgentPromptPromise(renderGate.wait(), deliverySignal)
        } else if (options.composerReady) {
          await waitForAgentPromptDelay(
            AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + pasteIngestMs,
            deliverySignal
          )
        } else {
          const agent = this.getPtyAgent(ptyId)
          const submitDelayMs = options.promptForSchedule
            ? resolveAgentPromptSubmitDelayForAgent(
                writeHostPlatform,
                options.promptForSchedule,
                agent
              )
            : getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength)
          await waitForAgentPromptDelay(submitDelayMs, deliverySignal)
        }
        try {
          await beforeWrite(deliverySignal)
        } catch (error) {
          if (options.suffixFailureError) {
            throw new Error(options.suffixFailureError)
          }
          throw error
        }
      }
      assertWritable(deliverySignal)
      baseline = preSubmitBaseline ?? this.getAgentPromptActivity(handle, ptyId, waitTextCache)
      this.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
      if (
        !submitWithPaste &&
        !this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind)
      ) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      if (!submitWithPaste) {
        options.onSubmitWritten?.()
      }
    } catch (error) {
      this.assertAgentPromptGeneration(ptyId, generation)
      throw error
    } finally {
      renderGate?.dispose()
    }
    const submits = submitWithPaste
      ? 1
      : 1 +
        (await this.resubmitHeldAgentPrompt(
          ptyId,
          generation,
          {
            ...options,
            signal: admissionSignal,
            beforeWrite: () => beforeWrite(admissionSignal)
          },
          {
            baseline,
            readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
            prompt: options.promptForSchedule,
            heldBudgetMs: getAgentPromptHeldSubmitBudgetMs(
              writeHostPlatform,
              this.getPtyAgent(ptyId),
              pastePayload
            )
          }
        ))
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId))
    if (!options.acceptQueued || !options.requestId) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        timeoutMs: effectTimeoutMs,
        signal: observationSignal
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
        signal: observationSignal,
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
