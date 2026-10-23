import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import type { AgentTransitionDetector } from '../../../agent-hooks/agent-transition-detector'
import { OrcaRuntimeWithWriteTerminalAgentPrompt } from './terminal-agent-prompt'
import {
  AgentPromptPermissionReturnedError,
  waitWhileAgentPromptBlocked
} from './agent-prompt-permission-hold'

export abstract class OrcaRuntimeWithSubmitTerminalAgentPrompt extends OrcaRuntimeWithWriteTerminalAgentPrompt {
  abstract readonly agentTransitions: Pick<AgentTransitionDetector, 'subscribe'>

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
        const delivery = await this.serializeAgentPromptSubmission(ptyId, generation, async () => {
          this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
          this.assertAgentPromptGeneration(ptyId, generation)
          this.assertAgentPromptExpectedBinding(handle, options.expectedBinding)
          return await this.writeTerminalAgentPrompt(handle, ptyId, generation, payload, {
            ...options,
            promptForSchedule: prompt
          })
        })
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
      signal: options.signal
    })
  }
}
