// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './orca-runtime-core'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  AGENT_PROMPT_SUBMIT,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import {
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import {
  AGENT_PROMPT_ECHO_POLL_INTERVAL_MS,
  AGENT_PROMPT_ECHO_SETTLE_MS,
  deriveAgentPromptPasteEchoProbe,
  getAgentPromptPasteEchoTimeoutMs,
  isAgentPromptPasteEchoObserved
} from './agent-prompt-paste-echo'

export class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<number> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
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
        // Why: the render gate is a readiness signal, not proof of ingest -- a redraw can
        // fire before the child has attached the completed paste, so the byte-count floor
        // still has to hold even on the closed-loop path.
        await Promise.all([
          waitForAgentPromptPromise(renderGate.wait(), options.signal),
          waitForAgentPromptDelay(
            getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength),
            options.signal
          )
        ])
      } finally {
        renderGate.dispose()
      }
      // Why: the gate is a readiness signal for redraw activity, not proof the composer
      // consumed the paste -- on Windows a Codex pane can still be streaming per-keystroke
      // redraws past the gate's hard cap, and Enter written mid-burst becomes a stray
      // newline (agent_prompt_stalled). Poll the pane for the paste tail (or a placeholder
      // like "[Pasted text #1 +N lines]") before proceeding.
      await this.waitForAgentPromptPasteEcho(
        handle,
        ptyId,
        generation,
        pastePayload,
        writeHostPlatform,
        options
      )
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
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT)) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
    await verifyAgentPromptSubmission({
      baseline,
      readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
      timeoutMs: resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId)),
      signal: options.signal
    })
    return 1
  }

  /** Polls the pane for the paste tail (or a collapse placeholder) so Enter never overtakes a
   *  redraw burst the render gate's hard cap already gave up waiting on. Best-effort: on
   *  timeout it falls back to today's behavior rather than blocking submission indefinitely. */
  private async waitForAgentPromptPasteEcho(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    writeHostPlatform: NodeJS.Platform,
    options: RuntimeTerminalWriteOptions
  ): Promise<void> {
    const probe = deriveAgentPromptPasteEchoProbe(pastePayload)
    if (probe === null) {
      return
    }
    const deadlineAt = Date.now() + getAgentPromptPasteEchoTimeoutMs(writeHostPlatform)
    while (Date.now() < deadlineAt) {
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      const waitText = this.getTerminalAgentStatusSnapshot(handle, ptyId).waitText
      if (isAgentPromptPasteEchoObserved(waitText, probe)) {
        await waitForAgentPromptDelay(AGENT_PROMPT_ECHO_SETTLE_MS, options.signal)
        return
      }
      await waitForAgentPromptDelay(
        Math.min(AGENT_PROMPT_ECHO_POLL_INTERVAL_MS, Math.max(0, deadlineAt - Date.now())),
        options.signal
      )
    }
  }
}
