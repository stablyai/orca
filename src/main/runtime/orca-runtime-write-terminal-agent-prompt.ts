// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import type { RuntimeTerminalPromptDelivery, RuntimeTerminalSend } from '../../shared/runtime-types'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './orca-runtime-core'
import { AGENT_PROMPT_SUBMIT } from '../../shared/agent-prompt-injection'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import {
  isTerminalSendSettlementAgent,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import type { PtyInputTransaction } from './pty-input-transactions'
import { writeUnverifiable, type WriteSettlement } from '../../shared/pty-write-settlement'
import {
  resolveAgentPromptInputSchedule,
  type AgentPromptInputSchedule
} from './agent-prompt-input-schedule'

export class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{
    submits: number
    prompt?: RuntimeTerminalPromptDelivery
    writeSettlement?: WriteSettlement
    bytesWritten: number
  }> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    await options.beforeWrite?.(ptyId)
    let inputTransaction: PtyInputTransaction | undefined
    let bytes
    try {
      bytes = await this.runTerminalInputTransaction(
        ptyId,
        (transaction) => {
          inputTransaction = transaction
          const pty = this.ptysById.get(ptyId)
          const schedule = resolveAgentPromptInputSchedule({
            platform: this.getPtyWriteHostPlatform(ptyId),
            agent: this.getPtyAgent(ptyId),
            pasteAgent: pty?.foregroundAgent ?? pty?.launchAgent ?? null,
            pastePayload,
            options
          })
          return this.writeTerminalAgentPromptBytes(
            handle,
            ptyId,
            generation,
            pastePayload,
            options,
            transaction,
            schedule,
            permissionBaseline
          )
        },
        {
          signal: options.signal,
          deadlineAt: options.deadlineAt
        }
      )
    } catch (error) {
      if (inputTransaction?.stopSignal.aborted && inputTransaction.bytesHandedToTransport) {
        return {
          submits: 0,
          bytesWritten: inputTransaction.bytesWritten,
          writeSettlement: writeUnverifiable('partial_write', true)
        }
      }
      throw error
    }
    const bytesWritten = inputTransaction?.bytesWritten ?? 0
    const { submits, baseline, waitTextCache } = bytes
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId))
    if (!options.acceptQueued || !options.requestId) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        timeoutMs: effectTimeoutMs,
        signal: options.signal
      })
      return { submits, bytesWritten }
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
      bytesWritten,
      prompt: inputAccepted
    }
    options.onInputAccepted?.(checkpoint)
    // Providers without a lifecycle verifier still get an honest accepted
    // receipt; they must not fail a Dispatch merely because Orca cannot prove
    // submission through hooks.
    if (!settlementAgent) {
      return { submits, bytesWritten, prompt: inputAccepted }
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
        bytesWritten,
        prompt: {
          ...inputAccepted,
          stages: ['input_accepted', 'turn_started']
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return { submits, bytesWritten, prompt: inputAccepted }
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
        return {
          submits,
          bytesWritten,
          prompt: { ...inputAccepted, observation: 'permission' }
        }
      }
      throw error
    }
  }

  private async writeTerminalAgentPromptBytes(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions,
    transaction: PtyInputTransaction,
    schedule: AgentPromptInputSchedule,
    permissionBaseline: AgentPromptActivity
  ) {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const { submitWithPaste, pasteIngestMs, submitDelayMs } = schedule
    const writeSignal = options.signal
      ? AbortSignal.any([options.signal, transaction.stopSignal])
      : transaction.stopSignal
    // Why no gate for a ready composer: a live Claude never settles it, so Enter always waited out
    // its 8 s cap, where the desktop's own paste submitted in about 2 s.
    const renderGate = options.composerReady
      ? null
      : this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
    const disposeRenderGate = (): void => {
      transaction.stopSignal.removeEventListener('abort', disposeRenderGate)
      renderGate?.dispose()
    }
    if (renderGate) {
      transaction.stopSignal.addEventListener('abort', disposeRenderGate, { once: true })
    }
    const waitTextCache: AgentPromptWaitTextCache = {}
    const preSubmitBaseline = submitWithPaste
      ? this.getAgentPromptActivity(handle, ptyId, waitTextCache)
      : undefined
    try {
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      options.beforeWrite?.revalidate?.(ptyId)
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      this.assertAgentPromptPermissionSafe(
        permissionBaseline,
        this.getAgentPromptActivity(handle, ptyId)
      )
      // Keep the bracketed paste frame in one PTY write; Claude's composer can drop the
      // beginning when a large frame is split into independently processed chunks.
      transaction.beforeWrite()
      renderGate?.arm()
      const initialWrite = submitWithPaste ? pastePayload + AGENT_PROMPT_SUBMIT : pastePayload
      if (!transaction.write(initialWrite, options.inputKind)) {
        throw new Error('terminal_not_writable')
      }
    } catch (error) {
      disposeRenderGate()
      throw error
    }

    if (submitWithPaste) {
      // The Enter was part of the paste frame; waiting here would only delay receipt settlement.
      disposeRenderGate()
    } else if (renderGate) {
      try {
        await waitForAgentPromptPromise(renderGate.wait(), writeSignal)
      } finally {
        disposeRenderGate()
      }
    } else {
      await waitForAgentPromptDelay(submitDelayMs, writeSignal)
    }
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    if (!submitWithPaste) {
      try {
        await transaction.awaitExternal(() =>
          (options.beforeWrite?.revalidate ?? options.beforeWrite)?.(ptyId)
        )
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
      if (!transaction.write(AGENT_PROMPT_SUBMIT, options.inputKind)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
    }
    const submits =
      options.composerReady && !submitWithPaste
        ? 1 +
          (await this.resubmitAgentPromptAfterRetryDelay(
            ptyId,
            generation,
            options,
            transaction,
            schedule.retryDelayMs,
            writeSignal
          ))
        : 1
    return { submits, baseline, waitTextCache }
  }

  /**
   * The desktop draft paste's second Enter, for agents whose composer can render before Enter is
   * live (`submitRetryDelayMs`). Best effort: it never fails a prompt the first Enter submitted.
   */
  private async resubmitAgentPromptAfterRetryDelay(
    ptyId: string,
    generation: number,
    options: RuntimeAgentPromptWriteOptions,
    transaction: PtyInputTransaction,
    retryDelayMs: number | undefined,
    writeSignal: AbortSignal
  ): Promise<number> {
    if (retryDelayMs === undefined) {
      return 0
    }
    try {
      await waitForAgentPromptDelay(retryDelayMs, writeSignal)
      this.assertAgentPromptGeneration(ptyId, generation)
      await transaction.awaitExternal(() =>
        (options.beforeWrite?.revalidate ?? options.beforeWrite)?.(ptyId)
      )
      return transaction.write(AGENT_PROMPT_SUBMIT, options.inputKind) ? 1 : 0
    } catch {
      return 0
    }
  }
}
