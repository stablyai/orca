import { agentPromptObservationSignal } from './agent-prompt-signals'
import type { RuntimeAgentPromptWriteOptions } from './agent-prompt-write-options'
import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import type { AgentTransitionDetector } from '../../../agent-hooks/agent-transition-detector'
import { OrcaRuntimeWithWriteTerminalAgentPrompt } from './terminal-agent-prompt'
import type { AgentPromptRetarget } from './terminal-agent-prompt-source'
import {
  AgentPromptPermissionReturnedError,
  waitWhileAgentPromptBlocked
} from './agent-prompt-permission-hold'

export abstract class OrcaRuntimeWithSubmitTerminalAgentPrompt extends OrcaRuntimeWithWriteTerminalAgentPrompt {
  abstract readonly agentTransitions: Pick<AgentTransitionDetector, 'subscribe'>

  /** Every prompt write judges a restored permission wait on the screen as it is now (#35962).
   *  The write that follows still runs its own turn checks and keeps the request's one end. */
  protected override writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions,
    atTurn?: (ptyId: string) => void,
    retarget?: AgentPromptRetarget
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }> {
    const write = () =>
      super.writeTerminalAgentPrompt(
        handle,
        ptyId,
        generation,
        pastePayload,
        options,
        atTurn,
        retarget
      )
    return this.refreshRestoredWait(handle, ptyId)?.then(write) ?? write()
  }

  protected async submitTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    prompt: string,
    payload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    for (;;) {
      if (options.onPermission === 'wait') {
        await this.waitWhileTerminalAgentPromptBlocked(handle, ptyId, generation, options)
      }
      try {
        const delivery = await this.writeTerminalAgentPrompt(
          handle,
          ptyId,
          generation,
          payload,
          { ...options, promptForSchedule: prompt },
          () => {
            this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
            this.assertAgentPromptGeneration(ptyId, generation)
            this.assertAgentPromptExpectedBinding(handle, options.expectedBinding)
          }
        )
        const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
        return {
          handle,
          accepted: true,
          bytesWritten,
          ...(delivery.prompt ? { prompt: delivery.prompt } : {})
        }
      } catch (error) {
        // A prompt that came back before the paste wrote nothing, so the hold resumes.
        if (!(error instanceof AgentPromptPermissionReturnedError)) {
          throw error
        }
      }
    }
  }

  /** Outside the per-PTY queue, so a held prompt never delays another caller's write or refusal. */
  private waitWhileTerminalAgentPromptBlocked(
    handle: string,
    ptyId: string,
    generation: number,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<void> {
    const paneKey = this.getPaneKeyForTerminalHandle(handle)
    return waitWhileAgentPromptBlocked({
      isBlocked: () => {
        this.assertAgentPromptGeneration(ptyId, generation)
        this.assertAgentPromptExpectedBinding(handle, options.expectedBinding)
        const activity = this.getAgentPromptActivity(handle, ptyId)
        return this.isAgentPromptPermissionBlocked(activity, activity)
      },
      refresh: () => this.refreshRestoredWait(handle, ptyId),
      ...(paneKey
        ? {
            subscribeStatus: (wake: () => void) =>
              this.agentTransitions.subscribe((change) => {
                if (change.paneKey === paneKey) {
                  wake()
                }
              })
          }
        : {}),
      subscribeExit: (exited) => this.subscribeToPtyExit(ptyId, exited),
      // The request's lifetime: no timeout of its own unless the caller set a deadline (main).
      signal: options.generatedLifetime?.signal ?? agentPromptObservationSignal(options)
    })
  }
}
