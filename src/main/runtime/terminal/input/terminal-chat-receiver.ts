import { OrcaRuntimeWithWriteTerminalAgentPrompt } from './terminal-agent-prompt'
import {
  sameNativeChatPromptObservation,
  type NativeChatPromptBinding
} from '../../../../shared/native-chat/input/native-chat-prompt-observation'
import { isTerminalForegroundObservation } from '../../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import type { AgentPromptExpectedBinding } from './agent-prompt-write-options'
export abstract class OrcaRuntimeWithTerminalChatReceiver extends OrcaRuntimeWithWriteTerminalAgentPrompt {
  protected captureChatPromptBinding(
    handle: string,
    binding: AgentPromptExpectedBinding & { generation: number }
  ): NativeChatPromptBinding | undefined {
    try {
      const processIncarnation = this.getTerminalProcessIncarnation(handle)
      if (!processIncarnation) {
        return undefined
      }
      const captured: NativeChatPromptBinding = {
        runtimeId: this.getRuntimeId(),
        ptyId: binding.ptyId,
        generation: binding.generation,
        processIncarnation
      }
      const paneKey = this.paneOfPty(this.ptysById.get(binding.ptyId)).paneKey
      if (!paneKey) {
        return captured
      }
      const identity = this.readObservedAgentStatusPaneIdentityFn(paneKey)
      const row = this.getAgentStatusSnapshotForPaneFn?.(paneKey)[0]
      if (
        identity.kind === 'observed' &&
        identity.terminalHandle === handle &&
        identity.processIncarnation === processIncarnation &&
        sameNativeChatPromptObservation(identity.rootBaseline?.observation, row?.observation)
      ) {
        captured.rootBaseline = identity.rootBaseline
      }
      return captured
    } catch {
      return undefined
    }
  }
  protected async chatReceiverIsShell(binding: AgentPromptExpectedBinding): Promise<boolean> {
    const controller = this.ptyController
    if (!controller) {
      return false
    }
    try {
      if (await controller.confirmShellForeground?.(binding.ptyId)) {
        return true
      }
      if (!controller.supportsForegroundObservation?.(binding.ptyId)) {
        return false
      }
      const inspected = await controller.inspectProcess?.(binding.ptyId, {
        foregroundOnly: true,
        expectedIncarnationId: binding.processIncarnation
      })
      const observation = inspected?.foregroundObservation
      return (
        isTerminalForegroundObservation(observation) &&
        observation.ptyId === binding.ptyId &&
        observation.ptyIncarnationId === binding.processIncarnation &&
        observation.verdict === 'observed' &&
        observation.foregroundKind === 'shell'
      )
    } catch {
      return false
    }
  }
}
