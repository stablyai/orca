import { assertAgentPromptRequestActive } from './agent-prompt-signals'
import type { AgentPromptExpectedBinding } from './agent-prompt-write-options'
import { OrcaRuntimeWithResubmitHeldAgentPrompt } from './terminal-agent-prompt-resubmit'

/** Whether a prompt's next write may still reach the terminal it was admitted for. */
export abstract class OrcaRuntimeWithAgentPromptBinding extends OrcaRuntimeWithResubmitHeldAgentPrompt {
  protected assertAgentPromptExpectedBinding(
    handle: string,
    expected: AgentPromptExpectedBinding | undefined
  ): void {
    if (!expected) {
      return
    }
    const current = this.getTerminalPromptRequestBinding(handle)
    if (
      current.ptyId !== expected.ptyId ||
      current.processIncarnation !== expected.processIncarnation
    ) {
      throw new Error('terminal_handle_stale')
    }
  }

  /** Checked before every write of one prompt: a cancel, a replaced process or a stopping PTY ends
   *  it, so nothing meant for one process reaches its replacement. */
  protected assertAgentPromptWritable(
    target: {
      handle: string
      ptyId: string
      generation: number
      incarnationId: string | null | undefined
      expectedBinding: AgentPromptExpectedBinding | undefined
    },
    signal: AbortSignal
  ): void {
    const { handle, ptyId } = target
    assertAgentPromptRequestActive(signal)
    this.assertAgentPromptGeneration(ptyId, target.generation)
    this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    if (
      target.incarnationId != null &&
      this.ptysById.get(ptyId)?.incarnationId !== target.incarnationId
    ) {
      throw new Error('terminal_handle_stale')
    }
    this.assertAgentPromptExpectedBinding(handle, target.expectedBinding)
    if (this.isPtyStopRequested(ptyId)) {
      throw new Error('terminal_not_writable')
    }
  }
}
