// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import type { RuntimeTerminalPromptDelivery, RuntimeTerminalSend } from '../../shared/runtime-types'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './orca-runtime-core'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  AGENT_PROMPT_SUBMIT,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import {
  isTerminalSendSettlementAgent,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import { createHash } from 'node:crypto'
import { normalizeOmpPromptInput } from './omp-prompt-readiness'

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
    await this.waitForOmpPromptReadiness(handle, ptyId, generation, options.signal)
    this.assertAgentPromptPermissionSafe(
      permissionBaseline,
      this.getAgentPromptActivity(handle, ptyId)
    )
    const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
    const writeHostPlatform = this.getPtyWriteHostPlatform(ptyId)
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    const renderGate = this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
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
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      this.assertOmpPromptReadiness(ptyId)
      // Keep the bracketed paste frame in one PTY write; Claude's composer can drop the
      // beginning when a large frame is split into independently processed chunks.
      renderGate?.arm()
      if (!this.ptyController?.write(ptyId, pastePayload)) {
        throw new Error('terminal_not_writable')
      }
    } catch (error) {
      renderGate?.dispose()
      throw error
    }

    if (renderGate) {
      try {
        await waitForAgentPromptPromise(renderGate.wait(), options.signal)
      } finally {
        renderGate.dispose()
      }
    } else {
      await waitForAgentPromptDelay(
        getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength),
        options.signal
      )
    }
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
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
    const waitTextCache: AgentPromptWaitTextCache = {}
    const baseline = this.getAgentPromptActivity(handle, ptyId, waitTextCache)
    this.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
    this.assertOmpPromptReadiness(ptyId)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT)) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId))
    const expectedOmpPromptFingerprint =
      this.getPtyAgent(ptyId) === 'omp'
        ? createHash('sha256')
            .update(
              normalizeOmpPromptInput(
                pastePayload.slice(
                  AGENT_PROMPT_BRACKETED_PASTE_START.length,
                  -AGENT_PROMPT_BRACKETED_PASTE_END.length
                )
              )
            )
            .digest('hex')
        : undefined
    if (!options.acceptQueued || !options.requestId) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        expectedOmpPromptFingerprint,
        timeoutMs: effectTimeoutMs,
        signal: options.signal
      })
      this.agentPromptAcceptedGenerationByPtyId.set(ptyId, generation)
      return { submits: 1 }
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
      requestId: options.requestId, stages: ['input_accepted'], provider: settlementAgent ?? 'unsupported',
      observation: settlementAgent ? 'supported' : 'unsupported', processIncarnation: binding.processIncarnation,
      generation, baselineWorkingSequence: baseline.workingSequence,
      baselineExplicitWorkingStartedAt: baseline.explicitWorkingStartedAt, baselinePermissionSequence: baseline.permissionSequence
    }
    const checkpoint: RuntimeTerminalSend = {
      handle, accepted: true, bytesWritten: Buffer.byteLength(pastePayload, 'utf8') + 1, prompt: inputAccepted
    }
    options.onInputAccepted?.(checkpoint)
    if (!settlementAgent) return { submits: 1, prompt: inputAccepted }
    this.registerAgentPromptRequest(ptyId, generation, options.requestId, baseline.workingSequence, baseline.explicitWorkingStartedAt)
    try {
      await verifyAgentPromptSubmission({
        baseline, readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        acceptTurnStart: (evidence) => this.acceptAgentPromptTurnStart(ptyId, generation, options.requestId!, baseline.workingSequence, baseline.explicitWorkingStartedAt, evidence),
        allowOutputEvidence: false, expectedOmpPromptFingerprint, signal: options.signal,
        timeoutMs: options.observationTimeoutMs ?? effectTimeoutMs
      })
      this.agentPromptAcceptedGenerationByPtyId.set(ptyId, generation)
      this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
      return { submits: 1, prompt: { ...inputAccepted, stages: ['input_accepted', 'turn_started'] } }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') return { submits: 1, prompt: inputAccepted }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
        return { submits: 1, prompt: { ...inputAccepted, observation: 'permission' } }
      }
      throw error
    }
  }

  private async waitForOmpPromptReadiness(
    handle: string,
    ptyId: string,
    generation: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.getPtyAgent(ptyId) !== 'omp') {
      return
    }
    const baseline = this.getAgentPromptActivity(handle, ptyId)
    const deadline = Date.now() + 60_000
    while (!this.ompPromptReadinessByPtyId.get(ptyId)?.ready) {
      assertAgentPromptRequestActive(signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      this.assertAgentPromptPermissionSafe(baseline, this.getAgentPromptActivity(handle, ptyId))
      if (Date.now() >= deadline) {
        throw new Error('agent_prompt_not_ready')
      }
      await waitForAgentPromptDelay(50, signal)
    }
    assertAgentPromptRequestActive(signal)
    this.assertAgentPromptGeneration(ptyId, generation)
  }

  private assertOmpPromptReadiness(ptyId: string): void {
    if (this.getPtyAgent(ptyId) === 'omp' && !this.ompPromptReadinessByPtyId.get(ptyId)?.ready) {
      throw new Error('agent_prompt_not_ready')
    }
  }
}
