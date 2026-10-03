// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveTerminalPane } from './orca-runtime-resolve-terminal-pane'
import { PROVEN_ABSENT_LEAF_PTY_TTL_MS, waitForAgentPromptPromise } from './orca-runtime-core'
import { pruneExpiredProvenAbsentLeafPtyVerdicts } from './proven-absent-leaf-pty-verdicts'
import type { RuntimeTerminalSend } from '../../shared/runtime-types'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type {
  PtyForegroundProcessRead,
  RuntimeAgentPromptWriteOptions
} from './runtime-terminal-contracts'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import {
  assertTerminalInputWithinLimitWithYield,
  buildTerminalSendPayload
} from './terminal-send-payload'
import {
  agentPromptTakesLeadLine,
  buildAgentPromptBodyBytes
} from '../../shared/agent-prompt-injection'

const AGENT_PROMPT_FOREGROUND_PROBE_TIMEOUT_MS = 2_000

export class OrcaRuntimeWithControllerKnowsPtyIsLive extends OrcaRuntimeWithResolveTerminalPane {
  private lastProvenAbsentLeafPtyVerdictPruneAt: number | undefined

  private pruneExpiredLeafPtyVerdicts(now: number): void {
    const lastPruneAt = this.lastProvenAbsentLeafPtyVerdictPruneAt
    // Per-key expiry stays exact; throttle whole-cache scans on the keystroke path.
    if (
      lastPruneAt !== undefined &&
      now >= lastPruneAt &&
      now - lastPruneAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS
    ) {
      return
    }
    this.lastProvenAbsentLeafPtyVerdictPruneAt = now
    pruneExpiredProvenAbsentLeafPtyVerdicts(
      this.provenAbsentLeafPtyVerdicts,
      now,
      PROVEN_ABSENT_LEAF_PTY_TTL_MS
    )
  }

  protected controllerKnowsPtyIsLive(ptyId: string): boolean {
    try {
      return this.ptyController?.hasPty?.(ptyId) === true
    } catch {
      // Why: liveness lookup failures are doubt; doubt never gates a write.
      return false
    }
  }

  /** True only on controller-proven absence; live, unknown, and probe errors all answer false. */
  protected isLeafPtyProvenAbsent(ptyId: string): Promise<boolean> {
    this.pruneExpiredLeafPtyVerdicts(Date.now())
    // Why hasPty and not ptysById: graph sync mirrors a connected record for
    // every leaf ptyId — including a prior process's — so runtime records can't
    // distinguish live from stale. The controller's exact-id hasPty is the
    // provider's own synchronous inventory: a known id is alive, skip probing
    // and supersede any cached verdict (the id came back).
    if (this.controllerKnowsPtyIsLive(ptyId)) {
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
      return Promise.resolve(false)
    }
    const verdictAt = this.provenAbsentLeafPtyVerdicts.get(ptyId)
    if (verdictAt !== undefined) {
      if (Date.now() - verdictAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS) {
        return Promise.resolve(true)
      }
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
    }
    const probeLiveness = this.ptyController?.probePtyLiveness?.bind(this.ptyController)
    if (!probeLiveness) {
      return Promise.resolve(false)
    }
    const inFlight = this.leafPtyAbsenceProbes.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = (async () => {
      try {
        if ((await probeLiveness(ptyId)) !== false) {
          return false
        }
        const now = Date.now()
        this.pruneExpiredLeafPtyVerdicts(now)
        this.provenAbsentLeafPtyVerdicts.set(ptyId, now)
        return true
      } catch {
        // Why: a failed probe is unknown, and unknown never rejects a write.
        return false
      } finally {
        this.leafPtyAbsenceProbes.delete(ptyId)
      }
    })()
    this.leafPtyAbsenceProbes.set(ptyId, probe)
    return probe
  }

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    },
    options: {
      signal?: AbortSignal
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      inputKind: TerminalInputKind
    }
  ): Promise<RuntimeTerminalSend> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = buildTerminalSendPayload(action)
      if (payload === null) {
        throw new Error('invalid_terminal_send')
      }
      await assertTerminalInputWithinLimitWithYield(action.text)
      await this.writeTerminalAction(pty.pty.ptyId, action, payload, options)
      return {
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(payload, 'utf8')
      }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildTerminalSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    await assertTerminalInputWithinLimitWithYield(action.text)
    // Why: leaf.writable mirrors the renderer graph, which can still answer for
    // a prior process's ptyId — and provider writes to unknown ids are accepted
    // no-ops. Only controller-proven absence rejects; unknown proceeds (a
    // restored daemon session takes writes before its pane remounts).
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }

    await this.writeTerminalAction(leaf.ptyId, action, payload, options)

    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
    }
  }

  private async resolveAgentPromptConsumer(
    ptyId: string,
    generation: number,
    signal?: AbortSignal
  ): Promise<TuiAgent | null> {
    const pty = this.ptysById.get(ptyId)
    const controller = this.ptyController
    const read = this.readPtyForegroundProcessFromController(ptyId, pty?.lastOscTitleAt ?? 0)
    let result: PtyForegroundProcessRead | null = null
    let timer: NodeJS.Timeout | undefined
    try {
      if (read) {
        // Inspection must not inherit the relay's much longer RPC timeout on a writable PTY.
        const expired = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), AGENT_PROMPT_FOREGROUND_PROBE_TIMEOUT_MS)
        })
        result = await waitForAgentPromptPromise(Promise.race([read, expired]), signal)
      }
    } finally {
      clearTimeout(timer)
    }
    this.assertAgentPromptGeneration(ptyId, generation)
    if (controller !== this.ptyController || (result && result.controller !== controller)) {
      throw new Error('terminal_not_writable')
    }
    const fallback = pty?.foregroundAgent ?? pty?.launchAgent ?? null
    if (read && !result) {
      throw new Error('agent_prompt_foreground_unavailable')
    }
    if (result?.available && result.process) {
      const recognized = recognizeAgentProcess(result.process)?.agent
      if (recognized) {
        return recognized
      }
      if (!isAgentForegroundWrapperProcess(result.process)) {
        return null
      }
    }
    // Unframed Grok input can execute as shell commands after an agent exits. A cache,
    // generic wrapper, empty lookup, or failed inspection cannot authorize those bytes.
    if (fallback === 'grok') {
      throw new Error('agent_prompt_foreground_unavailable')
    }
    return fallback
  }

  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const pty = this.getLivePtyForHandle(handle)
    const leaf = pty ? null : this.getLiveLeafForHandle(handle).leaf
    const ptyId = pty?.pty.ptyId ?? leaf?.ptyId
    if (!ptyId || (pty ? !pty.pty.connected : !leaf?.writable)) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    let payload = ''
    const delivery = await this.serializeAgentPromptSubmission(ptyId, generation, async () => {
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      this.assertAgentPromptGeneration(ptyId, generation)
      if (leaf && (await this.isLeafPtyProvenAbsent(ptyId))) {
        throw new Error('terminal_not_writable')
      }
      // Probe when the queued prompt is ready: its consumer can differ from the original launcher.
      const agent = await this.resolveAgentPromptConsumer(ptyId, generation, options.signal)
      payload = buildAgentPromptBodyBytes(
        prompt,
        agent,
        agentPromptTakesLeadLine(agent) ? options.leadLine : undefined
      )
      await assertTerminalInputWithinLimitWithYield(payload)
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      this.assertAgentPromptGeneration(ptyId, generation)
      return await this.writeTerminalAgentPrompt(
        handle,
        ptyId,
        generation,
        payload,
        { ...options, promptForSchedule: prompt },
        agent
      )
    })
    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8') + delivery.submits,
      ...(delivery.prompt ? { prompt: delivery.prompt } : {})
    }
  }
}
