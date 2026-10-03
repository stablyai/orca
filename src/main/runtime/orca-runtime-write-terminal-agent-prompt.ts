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
  AGENT_PROMPT_COMPOSER_NOT_EMPTY_ERROR,
  classifyAgentPromptComposerResidue,
  type AgentPromptComposerResidue
} from './agent-prompt-composer-residue'
import { AgentPromptComposerLedger } from './agent-prompt-composer-ledger'
import {
  AGENT_PROMPT_SUBMIT,
  agentPromptSubmitJoinsPasteFrame,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../shared/agent-prompt-injection'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import {
  isTerminalSendSettlementAgent,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

export class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  private readonly agentPromptComposerLedger = new AgentPromptComposerLedger((ptyId, onParsed) =>
    this.watchAgentPromptComposer(ptyId, onParsed)
  )

  protected getJudgeableHeadlessTerminal(ptyId: string) {
    const state = this.headlessTerminals.get(ptyId)
    // Why: a provider-restored suffix or a pending hydration is not the whole screen, and doubt
    // never blocks a write.
    if (
      !state ||
      this.providerSnapshotPreferredPtys.has(ptyId) ||
      this.headlessHydrationState.get(ptyId) === 'pending'
    ) {
      return null
    }
    return state
  }

  private async readAgentPromptComposerResidue(
    ptyId: string,
    generation: number,
    pastePayload: string,
    signal?: AbortSignal
  ): Promise<{ residue: AgentPromptComposerResidue; parsedThrough: Promise<void> | null }> {
    const state = this.getJudgeableHeadlessTerminal(ptyId)
    if (!state) {
      return { residue: 'none', parsedThrough: null }
    }
    const settleMs = this.agentPromptComposerLedger.settleMsLeft(ptyId, generation)
    if (settleMs > 0) {
      await waitForAgentPromptDelay(settleMs, signal)
    }
    const parsedThrough = state.writeChain
    await waitForAgentPromptPromise(parsedThrough, signal)
    if (
      this.headlessTerminals.get(ptyId) !== state ||
      this.getPtyLifecycleGeneration(ptyId) !== generation
    ) {
      return { residue: 'none', parsedThrough: null }
    }
    return {
      residue: classifyAgentPromptComposerResidue(
        state.emulator.getCursorLineContext(),
        pastePayload,
        this.agentPromptComposerLedger.getOwnPaste(ptyId, generation)
      ),
      parsedThrough
    }
  }

  /** Synchronous re-read: is the composer still exactly the parked prompt judged before the awaits? */
  private isAgentPromptStillParked(
    ptyId: string,
    generation: number,
    pastePayload: string,
    parsedThrough: Promise<void> | null
  ): boolean {
    const state = this.getJudgeableHeadlessTerminal(ptyId)
    // Why: a newer write-chain link means PTY output arrived since the read, parsed or not yet.
    if (
      !state ||
      state.writeChain !== parsedThrough ||
      this.getPtyLifecycleGeneration(ptyId) !== generation
    ) {
      return false
    }
    return (
      classifyAgentPromptComposerResidue(
        state.emulator.getCursorLineContext(),
        pastePayload,
        this.agentPromptComposerLedger.getOwnPaste(ptyId, generation)
      ) === 'same-prompt'
    )
  }

  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{ submits: number; pasted: boolean; prompt?: RuntimeTerminalPromptDelivery }> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    // Why (#15976): a paste concatenates onto whatever the composer holds, so a retry after an
    // unobserved submit corrupted both prompts. Refuse foreign text; re-submit our own parked prompt.
    const composer = await this.readAgentPromptComposerResidue(
      ptyId,
      generation,
      pastePayload,
      options.signal
    )
    if (composer.residue === 'foreign') {
      throw new Error(AGENT_PROMPT_COMPOSER_NOT_EMPTY_ERROR)
    }
    const promptAlreadyParked = composer.residue === 'same-prompt'
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    const writeHostPlatform = this.getPtyWriteHostPlatform(ptyId)
    const pty = this.ptysById.get(ptyId)
    // OMP treats a large bracketed paste as a menu unless submit arrives in the same PTY write.
    // Once a foreground agent is known, it is the process that will consume the bytes;
    // launchAgent is only the fallback during startup before process detection settles.
    // A parked prompt needs only its Enter, which then goes out as the first and only write.
    const submitWithPaste =
      promptAlreadyParked ||
      agentPromptSubmitJoinsPasteFrame(pty?.foregroundAgent ?? pty?.launchAgent)
    const pasteByteLength = promptAlreadyParked ? 0 : Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    const renderGate = promptAlreadyParked
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
      // Why: harmless output (a title) can arrive while beforeWrite awaits; judge the screen it left.
      const parked = promptAlreadyParked
        ? await this.readAgentPromptComposerResidue(ptyId, generation, pastePayload, options.signal)
        : null
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      this.assertAgentPromptPermissionSafe(
        permissionBaseline,
        this.getAgentPromptActivity(handle, ptyId)
      )
      // Why: beforeWrite awaited, and Enter alone submits whatever the composer holds by now.
      if (
        parked &&
        !this.isAgentPromptStillParked(ptyId, generation, pastePayload, parked.parsedThrough)
      ) {
        throw new Error(AGENT_PROMPT_COMPOSER_NOT_EMPTY_ERROR)
      }
      // Keep the bracketed paste frame in one PTY write; Claude's composer can drop the
      // beginning when a large frame is split into independently processed chunks.
      renderGate?.arm()
      const pasteWrite = promptAlreadyParked ? '' : pastePayload
      const initialWrite = submitWithPaste ? pasteWrite + AGENT_PROMPT_SUBMIT : pasteWrite
      if (!this.ptyController?.write(ptyId, initialWrite, options.inputKind)) {
        throw new Error('terminal_not_writable')
      }
      if (!promptAlreadyParked) {
        this.agentPromptComposerLedger.rememberPaste(ptyId, generation, pastePayload, (id) =>
          this.ptysById.has(id)
        )
      }
      if (submitWithPaste) {
        this.agentPromptComposerLedger.markSubmitted(ptyId, generation)
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
      if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      this.agentPromptComposerLedger.markSubmitted(ptyId, generation)
    }
    const pasted = !promptAlreadyParked
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId))
    if (!options.acceptQueued || !options.requestId) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        timeoutMs: effectTimeoutMs,
        signal: options.signal
      })
      // Why: an idle agent passes only on a turn start; a working one may pass on output alone.
      if (baseline.status !== 'working') {
        this.agentPromptComposerLedger.markLanded(ptyId, generation, pastePayload)
      }
      return { submits: 1, pasted }
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
      bytesWritten: pasteByteLength + 1,
      prompt: inputAccepted
    }
    options.onInputAccepted?.(checkpoint)
    // Providers without a lifecycle verifier still get an honest accepted
    // receipt; they must not fail a Dispatch merely because Orca cannot prove
    // submission through hooks.
    if (!settlementAgent) {
      return { submits: 1, pasted, prompt: inputAccepted }
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
      this.agentPromptComposerLedger.markLanded(ptyId, generation, pastePayload)
      return {
        submits: 1,
        pasted,
        prompt: {
          ...inputAccepted,
          stages: ['input_accepted', 'turn_started']
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return { submits: 1, pasted, prompt: inputAccepted }
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
        return {
          submits: 1,
          pasted,
          prompt: { ...inputAccepted, observation: 'permission' }
        }
      }
      throw error
    }
  }
}
