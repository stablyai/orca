import type { RuntimeAgentPromptWriteOptions } from '../runtime-terminal-contracts'
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'

export abstract class OrcaRuntimeWithPreparePiTerminalPrompt extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  async preparePiTerminalPrompt(
    handle: string,
    text: string
  ): Promise<Pick<RuntimeAgentPromptWriteOptions, 'beforeWrite' | 'expectedBinding'> | null> {
    // Pi normalizes controls and separates pasted path prefixes from an existing draft.
    // oxlint-disable-next-line no-control-regex -- preserve explicit raw control input.
    if (/^[/.~]|[\x00-\x09\x0b-\x1f\x7f]/u.test(text)) {
      return null
    }
    const binding = this.getTerminalPromptRequestBinding(handle)
    // Pi cannot inherit another launch provider's turn-verification contract.
    if (this.ptysById.get(binding.ptyId)?.launchAgent !== 'pi') {
      return null
    }
    const confirm = this.ptyController?.confirmForegroundProcess?.bind(this.ptyController)
    if (!confirm) {
      return null
    }
    const canPaste = async (): Promise<boolean> => {
      this.assertAgentPromptExpectedBinding(handle, binding)
      const state = this.headlessTerminals.get(binding.ptyId)
      // A partial suffix of a restored provider stream cannot certify negotiated modes.
      if (!state || this.providerSnapshotPreferredPtys.has(binding.ptyId)) {
        return false
      }
      if (recognizeAgentProcess(await confirm(binding.ptyId))?.agent !== 'pi') {
        return false
      }
      const pendingOutput = state.writeChain
      await pendingOutput
      this.assertAgentPromptExpectedBinding(handle, binding)
      return (
        state.writeChain === pendingOutput &&
        this.headlessTerminals.get(binding.ptyId) === state &&
        !this.providerSnapshotPreferredPtys.has(binding.ptyId) &&
        state.emulator.getModes().bracketedPaste
      )
    }
    if (!(await canPaste())) {
      return null
    }
    const pty = this.ptysById.get(binding.ptyId)
    // Clear stale Claude/Codex identity so the writer neither joins Enter nor claims settlement.
    if (pty) {
      pty.foregroundAgent = 'pi'
    }
    return {
      expectedBinding: binding,
      beforeWrite: async () => {
        if (!(await canPaste())) {
          throw new Error('agent_not_in_foreground')
        }
      }
    }
  }
}
