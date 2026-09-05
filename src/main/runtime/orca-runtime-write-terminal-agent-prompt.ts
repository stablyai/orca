// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './orca-runtime-core'
import { TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  AGENT_PROMPT_SUBMIT,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { AGENT_PROMPT_COMPOSER_READY_TIMEOUT_MS } from '../../shared/orchestration-timing-budgets'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import {
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import {
  type AgentPromptComposerVerdict,
  detectAgentPromptComposerVerdict
} from './agent-prompt-composer-pending'
import {
  resolveAgentDraftPasteReadySignal,
  waitForDraftPasteReadySignal
} from './runtime-worktree-startup-readiness'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'

export type AgentPromptWriteOptions = RuntimeTerminalWriteOptions & {
  /** Bound on waiting for a booting TUI's composer before the paste; agent default otherwise. */
  composerReadyTimeoutMs?: number
}

// Why: once the paste has settled, the composer gets this long to show the payload before Enter —
// a TUI still folding input into the paste would otherwise eat the submit.
const AGENT_PROMPT_COMPOSER_ECHO_WAIT_MS = 1_500
const AGENT_PROMPT_COMPOSER_ECHO_POLL_MS = 250

export class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    prompt: string,
    pastePayload: string,
    options: AgentPromptWriteOptions = {}
  ): Promise<number> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const initialActivity = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(initialActivity, initialActivity)
    // Why: a paste into a TUI that is still booting lands scrambled on its splash screen or parks
    // unsubmitted, whoever the caller is — the composer is observed before the first byte.
    const readiness = await this.waitForAgentPromptComposerReady(handle, ptyId, {
      timeoutMs: options.composerReadyTimeoutMs,
      signal: options.signal
    })
    if (readiness === 'timeout') {
      console.warn(
        `[agent-prompt] ${handle}: no composer readiness signal within budget; pasting anyway`
      )
    }
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
    // Why: Enter is only worth writing once the screen shows the paste was absorbed; until then the
    // TUI may still be folding input into it (Codex reads Windows console records) and eats the submit.
    const composerBeforeSubmit = await this.observeAgentPromptComposerBeforeSubmit(
      ptyId,
      generation,
      prompt,
      options.signal
    )
    const waitTextCache: AgentPromptWaitTextCache = {}
    // Why: every Enter — the first and each retry — re-runs the caller hook and re-checks that no
    // permission dialog took the pane meanwhile; a retry must never confirm a dialog.
    const guardSubmit = async (): Promise<void> => {
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
      this.assertAgentPromptPermissionSafe(
        permissionBaseline,
        this.getAgentPromptActivity(handle, ptyId, waitTextCache)
      )
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    }
    const writeSubmit = (): void => {
      if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
    }
    await guardSubmit()
    const baseline = this.getAgentPromptActivity(handle, ptyId, waitTextCache)
    writeSubmit()
    const outcome = await verifyAgentPromptSubmission({
      baseline,
      readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
      timeoutMs: resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId)),
      signal: options.signal,
      composer: {
        beforeSubmit: composerBeforeSubmit,
        read: () => this.readAgentPromptComposerVerdict(ptyId, generation, prompt),
        resubmit: async () => {
          await guardSubmit()
          writeSubmit()
        }
      }
    })
    if (outcome.enterRetries > 0 || outcome.evidence === 'composer-cleared') {
      console.warn(
        `[agent-prompt] ${handle}: submission proven by ${outcome.evidence} after ${outcome.enterRetries} extra Enter(s)`
      )
    }
    return 1 + outcome.enterRetries
  }

  /** Why: `terminal wait --for tui-idle` is the caller's gate; this is the paste's own. Any agent
   *  status, a known ready header, or a stream that has gone quiet means the composer exists; only
   *  a pane with none of those waits for the agent's composer signal, bounded by the budget. */
  protected async waitForAgentPromptComposerReady(
    handle: string,
    ptyId: string,
    options: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<'evidence' | 'ready' | 'timeout'> {
    const status = this.getAgentPromptActivity(handle, ptyId).status
    if (status === 'idle' || status === 'working') {
      return 'evidence'
    }
    if (isKnownReadyPromptPreview(this.getTerminalAgentStatusSnapshot(handle, ptyId).waitText)) {
      return 'evidence'
    }
    const lastOutputAt = this.ptysById.get(ptyId)?.lastOutputAt
    if (lastOutputAt && Date.now() - lastOutputAt >= TUI_IDLE_QUIESCENCE_MS) {
      return 'evidence'
    }
    const agent = this.getPtyAgent(ptyId)
    const ready = await waitForDraftPasteReadySignal(
      this.getWorktreeStartupReadinessHost(),
      ptyId,
      resolveAgentDraftPasteReadySignal(agent),
      options.timeoutMs ??
        Math.max(
          AGENT_PROMPT_COMPOSER_READY_TIMEOUT_MS,
          resolveDraftPasteReadyTimeoutMs(agent ?? undefined)
        ),
      options.signal
    )
    return ready ? 'ready' : 'timeout'
  }

  protected async readAgentPromptComposerVerdict(
    ptyId: string,
    generation: number,
    prompt: string
  ): Promise<AgentPromptComposerVerdict> {
    const state = await this.readVisibleTerminalState(ptyId)
    this.assertAgentPromptGeneration(ptyId, generation)
    return detectAgentPromptComposerVerdict(
      state ? { lines: state.lines, draft: state.draft } : null,
      prompt
    )
  }

  protected async observeAgentPromptComposerBeforeSubmit(
    ptyId: string,
    generation: number,
    prompt: string,
    signal?: AbortSignal
  ): Promise<AgentPromptComposerVerdict> {
    const deadline = Date.now() + AGENT_PROMPT_COMPOSER_ECHO_WAIT_MS
    let verdict = await this.readAgentPromptComposerVerdict(ptyId, generation, prompt)
    // Why: only a readable, still-empty composer is worth waiting on; an unreadable screen stays unknown.
    while (verdict === 'clear' && Date.now() < deadline) {
      await waitForAgentPromptDelay(AGENT_PROMPT_COMPOSER_ECHO_POLL_MS, signal)
      verdict = await this.readAgentPromptComposerVerdict(ptyId, generation, prompt)
    }
    return verdict
  }
}
