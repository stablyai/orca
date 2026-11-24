import { OrcaRuntimeWithPtyLiveness } from './terminal-pty-liveness'
import { agentPromptObservationSignal } from './agent-prompt-signals'
import { emitPipelineV2AcceptedInput } from '../../pipelines/v2/pipeline-v2-input-events'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { RuntimeLeafRecord } from '../records/runtime-terminal-state-records'
import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalSend
} from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal/input/terminal-bracketed-paste-text'
import type { RuntimeAgentPromptWriteOptions } from './agent-prompt-write-options'
import type { TerminalHandleRecord } from '../identity/terminal-handle-records'
import {
  assertTerminalInputWithinLimitWithYield,
  buildTerminalSendPayload
} from './terminal-send-payload'
import {
  agentPromptTakesLeadLine,
  buildAgentPromptPasteBytes
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'

export abstract class OrcaRuntimeWithControllerKnowsPtyIsLive extends OrcaRuntimeWithPtyLiveness {
  protected abstract writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined>
  protected abstract getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  protected abstract serializeAgentPromptSubmission<T>(
    ptyId: string,
    generation: number,
    submit: () => Promise<T>
  ): Promise<T>
  protected abstract assertAgentPromptGeneration(ptyId: string, expected: number): void
  protected abstract writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }>
  /** The opt-in path (`onPermission: 'wait'`, `expectedBinding`), pinned to `ptyId`. */
  protected abstract submitTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    prompt: string,
    payload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend>

  /** The PTY a handle names right now, read without resolving or refusing the handle. */
  private handlePtyId(handle: string): string | undefined {
    return (
      this.getLivePtyForHandle(handle)?.pty.ptyId ?? this.handles.get(handle)?.ptyId ?? undefined
    )
  }

  /** sendTerminal once plugin hooks decided (terminal-plugin-hooked-input.ts). */
  protected async sendTerminalAfterPluginHooks(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options: RuntimeTerminalWriteOptions
  ): Promise<RuntimeTerminalSend> {
    // Switch point: a saved pane main holds with no terminal yet starts first (once, shared).
    const starting = ORCA_LAYOUT_OWNER_IS_MAIN
      ? this.startRestoredHandlePane(handle, { signal: options.signal })
      : null
    if (starting) {
      const target = await starting
      return { ...(await this.sendTerminalAfterPluginHooks(target, action, options)), handle }
    }
    // Before resolving the target: a terminal closed or replaced during the wait is then refused, not written.
    await this.waitForPtyEndpointReattach(this.handlePtyId(handle), options.signal)
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
      if (!(await this.launchComposerAdmitsSubmit(pty.pty.ptyId, action, options))) {
        return { handle, accepted: false, bytesWritten: 0 }
      }
      const writeSettlement = await this.writeTerminalAction(
        pty.pty.ptyId,
        action,
        payload,
        options
      )
      emitPipelineV2AcceptedInput(
        this,
        { handle },
        options.inputKind,
        !writeSettlement || writeSettlement.outcome === 'accepted',
        payload
      )
      return {
        handle,
        accepted: !writeSettlement || writeSettlement.outcome === 'accepted',
        ...(writeSettlement ? { writeSettlement } : {}),
        bytesWritten:
          !writeSettlement || writeSettlement.outcome === 'accepted'
            ? Buffer.byteLength(payload, 'utf8')
            : 0
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
    // Graph writability can be stale and unknown-id writes no-op; refuse only controller-proven absence, permitting unknown restored-daemon liveness.
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    if (!(await this.launchComposerAdmitsSubmit(leaf.ptyId, action, options))) {
      return { handle, accepted: false, bytesWritten: 0 }
    }

    const writeSettlement = await this.writeTerminalAction(leaf.ptyId, action, payload, options)
    emitPipelineV2AcceptedInput(
      this,
      { handle },
      options.inputKind,
      !writeSettlement || writeSettlement.outcome === 'accepted',
      payload
    )

    return {
      handle,
      accepted: !writeSettlement || writeSettlement.outcome === 'accepted',
      ...(writeSettlement ? { writeSettlement } : {}),
      bytesWritten:
        !writeSettlement || writeSettlement.outcome === 'accepted'
          ? Buffer.byteLength(payload, 'utf8')
          : 0
    }
  }

  private async launchComposerAdmitsSubmit(
    ptyId: string,
    action: { enter?: boolean },
    options: RuntimeTerminalWriteOptions
  ): Promise<boolean> {
    if (!(options.waitForLaunchComposer && action.enter)) {
      return true
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    return (
      // No pending watch: not a fresh launch, or its watch already settled.
      ((await this.launchComposerReadyByPtyId.get(ptyId)) ?? true) &&
      // A held send must not land in a replacement process or outlive its cancelled request.
      this.getPtyLifecycleGeneration(ptyId) === generation &&
      options.signal?.aborted !== true
    )
  }

  /** sendTerminalAgentPrompt once plugin hooks decided. */
  protected async sendAgentPromptAfterPluginHooks(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    // Why the consuming agent: the foreground process reads the bytes; launchAgent covers startup.
    const payloadFor = (ptyId: string): string => {
      // Why: a launch prompt replaced the desktop's draft paste, so it sends that paste's bytes.
      if (options.inputKind === 'launch') {
        return wrapTerminalBracketedPasteText(prompt)
      }
      const pty = this.ptysById.get(ptyId)
      const agent = pty?.foregroundAgent ?? pty?.launchAgent
      return buildAgentPromptPasteBytes(
        prompt,
        agentPromptTakesLeadLine(agent) ? options.leadLine : undefined
      )
    }
    // Switch point: a saved pane main holds with no terminal yet starts first (once, shared).
    const starting = ORCA_LAYOUT_OWNER_IS_MAIN
      ? this.startRestoredHandlePane(handle, { signal: agentPromptObservationSignal(options) })
      : null
    if (starting) {
      const target = await starting
      return { ...(await this.sendAgentPromptAfterPluginHooks(target, prompt, options)), handle }
    }
    await this.waitForPtyEndpointReattach(
      this.handlePtyId(handle),
      agentPromptObservationSignal(options)
    )
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = payloadFor(pty.pty.ptyId)
      await assertTerminalInputWithinLimitWithYield(payload)
      // Only opted-in calls take the extra layer, so every default caller's timing is untouched.
      if (agentPromptWriteOptsIn(options)) {
        const result = await this.submitTerminalAgentPrompt(
          handle,
          pty.pty.ptyId,
          prompt,
          payload,
          options
        )
        emitPipelineV2AcceptedInput(this, { handle }, options.inputKind, result.accepted, prompt)
        return result
      }
      const generation = this.getPtyLifecycleGeneration(pty.pty.ptyId)
      const delivery = await this.serializeAgentPromptSubmission(
        pty.pty.ptyId,
        generation,
        async () => {
          this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
          this.assertAgentPromptGeneration(pty.pty.ptyId, generation)
          return await this.writeTerminalAgentPrompt(handle, pty.pty.ptyId, generation, payload, {
            ...options,
            promptForSchedule: prompt
          })
        }
      )
      const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
      emitPipelineV2AcceptedInput(this, { handle }, options.inputKind, true, prompt)
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
    const payload = payloadFor(leaf.ptyId)
    await assertTerminalInputWithinLimitWithYield(payload)
    // Use the same absence gate as sendTerminal; unknown liveness still permits the prompt.
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    if (agentPromptWriteOptsIn(options)) {
      const result = await this.submitTerminalAgentPrompt(
        handle,
        leaf.ptyId,
        prompt,
        payload,
        options
      )
      emitPipelineV2AcceptedInput(this, { handle }, options.inputKind, result.accepted, prompt)
      return result
    }
    const generation = this.getPtyLifecycleGeneration(leaf.ptyId)
    const delivery = await this.serializeAgentPromptSubmission(leaf.ptyId, generation, async () => {
      this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId!)
      this.assertAgentPromptGeneration(leaf.ptyId!, generation)
      return await this.writeTerminalAgentPrompt(handle, leaf.ptyId!, generation, payload, {
        ...options,
        promptForSchedule: prompt
      })
    })
    const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
    emitPipelineV2AcceptedInput(this, { handle }, options.inputKind, true, prompt)
    return {
      handle,
      accepted: true,
      bytesWritten,
      ...(delivery.prompt ? { prompt: delivery.prompt } : {})
    }
  }
}

function agentPromptWriteOptsIn(options: RuntimeAgentPromptWriteOptions): boolean {
  return options.onPermission === 'wait' || options.expectedBinding !== undefined
}
