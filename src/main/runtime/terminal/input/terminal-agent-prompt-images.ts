import {
  agentPromptObservationSignal,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './agent-prompt-signals'
import { assertTerminalInputAdmitted } from './terminal-input-admission'
import type { RuntimeAgentPromptWriteOptions } from './agent-prompt-write-options'
import type { RuntimeTerminalPromptDelivery } from '../../../../shared/runtime-terminal-send-contract'
import {
  AGENT_IMAGE_ATTACHMENT_SETTLE_MS,
  agentImageAttachmentPastes
} from '../../../../shared/agent-image-attachment-paste'
import { AgentPromptPermissionReturnedError } from './agent-prompt-permission-hold'
import { OrcaRuntimeWithWriteTerminalAgentPrompt } from './terminal-agent-prompt'

/** A prompt's images, pasted ahead of its text inside the same serialized prompt operation. Each
 *  image write gets the checks its text and Enter get; the text, or the Enter alone, follows once
 *  the agent has attached them. */
export abstract class OrcaRuntimeWithAgentPromptImages extends OrcaRuntimeWithWriteTerminalAgentPrompt {
  protected override async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery; imageBytes?: number }> {
    const { images, onPermission: _hold, onInputAccepted, ...textOptions } = options
    if (!images?.length) {
      return super.writeTerminalAgentPrompt(handle, ptyId, generation, pastePayload, options)
    }
    const pty = this.ptysById.get(ptyId)
    const pastes = agentImageAttachmentPastes(
      pty?.foregroundAgent ?? pty?.launchAgent,
      images,
      pastePayload.length > 0
    )
    const target = {
      handle,
      ptyId,
      generation,
      incarnationId: pty?.incarnationId,
      expectedBinding: options.expectedBinding
    }
    const lifecycle = this.getPtyLifecycleSignal(ptyId)
    const delivery = options.signal ? AbortSignal.any([options.signal, lifecycle]) : lifecycle
    const observation = agentPromptObservationSignal(options)
    const baseline = this.getAgentPromptActivity(handle, ptyId)
    let imageBytes = 0
    for (const paste of pastes) {
      // Before the first byte its observer may still withdraw the prompt; after it, only the host.
      const signal =
        imageBytes === 0 && observation ? AbortSignal.any([observation, delivery]) : delivery
      this.assertAgentPromptWritable(target, signal)
      await waitForAgentPromptPromise(
        Promise.resolve().then(() => options.beforeWrite?.(ptyId)),
        signal
      )
      this.assertAgentPromptWritable(target, signal)
      const current = this.getAgentPromptActivity(handle, ptyId)
      if (
        imageBytes === 0 &&
        options.onPermission === 'wait' &&
        this.isAgentPromptPermissionBlocked(baseline, current)
      ) {
        throw new AgentPromptPermissionReturnedError()
      }
      this.assertAgentPromptPermissionSafe(baseline, current)
      assertTerminalInputAdmitted(this, ptyId, options.inputSource)
      if (!this.ptyController?.write(ptyId, paste, options.inputKind)) {
        throw new Error('terminal_not_writable')
      }
      imageBytes += Buffer.byteLength(paste, 'utf8')
      options.onInputWritten?.()
    }
    await waitForAgentPromptDelay(AGENT_IMAGE_ATTACHMENT_SETTLE_MS, delivery)
    // The images are in: a permission prompt now refuses the rest rather than restarting it.
    const sent = await super.writeTerminalAgentPrompt(handle, ptyId, generation, pastePayload, {
      ...textOptions,
      ...(onInputAccepted
        ? {
            onInputAccepted: (send) =>
              onInputAccepted({ ...send, bytesWritten: send.bytesWritten + imageBytes })
          }
        : {})
    })
    return { ...sent, imageBytes }
  }
}
