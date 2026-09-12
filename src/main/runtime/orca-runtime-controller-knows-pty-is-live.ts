// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveTerminalPane } from './orca-runtime-resolve-terminal-pane'
import { PROVEN_ABSENT_LEAF_PTY_TTL_MS } from './orca-runtime-core'
import type { RuntimeTerminalSend } from '../../shared/runtime-types'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import {
  assertTerminalInputWithinLimitWithYield,
  buildTerminalSendPayload
} from './terminal-send-payload'
import { buildAgentPromptPasteBytes } from '../../shared/agent-prompt-injection'
import { waitForPtyDraftInputReady } from './runtime-pty-draft-input-ready'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

export class OrcaRuntimeWithControllerKnowsPtyIsLive extends OrcaRuntimeWithResolveTerminalPane {
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
        this.provenAbsentLeafPtyVerdicts.set(ptyId, Date.now())
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
    } = {}
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

  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions = {}
  ): Promise<RuntimeTerminalSend> {
    const payload = buildAgentPromptPasteBytes(prompt)
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      await assertTerminalInputWithinLimitWithYield(payload)
      const generation = this.getPtyLifecycleGeneration(pty.pty.ptyId)
      // Why: native/Structured Chat can own the pane with no composer; wait would hide typed refusal.
      agentSessionPtyWriteGate.assertAdmitted(pty.pty.ptyId)
      await this.waitForCodexPromptComposer(pty.pty.ptyId, options.signal)
      if (
        this.getPtyLifecycleGeneration(pty.pty.ptyId) !== generation ||
        this.ptysById.get(pty.pty.ptyId) !== pty.pty ||
        !pty.pty.connected
      ) {
        throw new Error('terminal_exited')
      }
      const delivery = await this.serializeAgentPromptSubmission(
        pty.pty.ptyId,
        generation,
        async () => {
          this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
          this.assertAgentPromptGeneration(pty.pty.ptyId, generation)
          return await this.writeTerminalAgentPrompt(
            handle,
            pty.pty.ptyId,
            generation,
            payload,
            options
          )
        }
      )
      const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
      return {
        handle,
        accepted: true,
        bytesWritten,
        ...(delivery.prompt ? { prompt: delivery.prompt } : {})
      }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    await assertTerminalInputWithinLimitWithYield(payload)
    // Why: same absence gate as sendTerminal — a stale graph mirror must not
    // accept a prompt into a void; unknown liveness still proceeds.
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    const ptyId = leaf.ptyId
    const generation = this.getPtyLifecycleGeneration(ptyId)
    agentSessionPtyWriteGate.assertAdmitted(ptyId)
    await this.waitForCodexPromptComposer(ptyId, options.signal)
    if (this.getPtyLifecycleGeneration(ptyId) !== generation) {
      throw new Error('terminal_exited')
    }
    const current = this.getLiveLeafForHandle(handle).leaf
    if (!current.writable || current.ptyId !== ptyId || (await this.isLeafPtyProvenAbsent(ptyId))) {
      throw new Error('terminal_not_writable')
    }
    const delivery = await this.serializeAgentPromptSubmission(ptyId, generation, async () => {
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      this.assertAgentPromptGeneration(ptyId, generation)
      return await this.writeTerminalAgentPrompt(handle, ptyId, generation, payload, options)
    })
    const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
    return {
      handle,
      accepted: true,
      bytesWritten,
      ...(delivery.prompt ? { prompt: delivery.prompt } : {})
    }
  }

  protected async waitForCodexPromptComposer(ptyId: string, signal?: AbortSignal): Promise<void> {
    const pty = this.ptysById.get(ptyId)
    if ((pty?.launchAgent ?? pty?.foregroundAgent) !== 'codex') {
      return
    }
    const ready = await waitForPtyDraftInputReady(
      {
        subscribeToData: (id, listener) => this.subscribeToTerminalData(id, listener),
        readRecentOutput: (id) => this.recentPtyOutputById.get(id)?.read(),
        subscribeToExit: (id, listener) => this.subscribeToPtyExit(id, listener)
      },
      ptyId,
      'codex',
      signal
    )
    if (!ready) {
      throw new Error('agent_composer_not_ready')
    }
  }
}
