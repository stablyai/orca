import type { NativeChatPromptBinding } from '../../../../shared/native-chat/input/native-chat-prompt-observation'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-terminal-send-contract'
import {
  writeUnverifiable,
  writeRefused,
  type WriteSettlement
} from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { AgentPromptExpectedBinding } from './agent-prompt-write-options'
import { assertAgentPromptRequestActive, waitForAgentPromptPromise } from './agent-prompt-signals'
import type { TerminalChatInput } from './terminal-chat-input-ownership'
import { assertTerminalInputAdmitted, type TerminalInputSource } from './terminal-input-admission'
import { OrcaRuntimeWithTerminalChatReceiver } from './terminal-chat-receiver'

export abstract class OrcaRuntimeWithTerminalChatInputWriter extends OrcaRuntimeWithTerminalChatReceiver {
  protected async runTerminalChatInput(
    handle: string,
    binding: AgentPromptExpectedBinding & { generation: number },
    entry: TerminalChatInput,
    perform: (write: (data: string) => Promise<void>, assertWritable: () => void) => Promise<void>,
    inputSource: TerminalInputSource = 'desktop',
    hooks?: {
      start?: (assertWritable: () => void) => Promise<NativeChatPromptBinding | undefined>
      beforeWrite?: (ptyId: string) => void
      afterWrite?: () => Promise<void>
    }
  ): Promise<RuntimeTerminalSend> {
    let bytesWritten = 0
    let effectPossible = false
    let weak = false
    let chatPromptBinding: NativeChatPromptBinding | undefined
    const result = (accepted: boolean, writeSettlement?: WriteSettlement): RuntimeTerminalSend => ({
      handle,
      accepted,
      bytesWritten,
      ...(chatPromptBinding ? { chatPromptBinding } : {}),
      writeSettlement: writeSettlement ?? writeRefused('provider_refused_write')
    })
    const assertWritable = (): void => {
      entry.assertActive()
      assertAgentPromptRequestActive(entry.signal)
      this.assertAgentPromptGeneration(binding.ptyId, binding.generation)
      this.assertAgentPromptExpectedBinding(handle, binding)
      this.assertLiveTerminalHandleTargetsPty(handle, binding.ptyId)
      if (!this.ptysById.get(binding.ptyId)?.connected || this.isPtyStopRequested(binding.ptyId)) {
        throw new Error('terminal_not_writable')
      }
      assertTerminalInputAdmitted(this, binding.ptyId, inputSource)
    }
    const write = async (data: string): Promise<void> => {
      assertWritable()
      const controller = this.ptyController
      if (!controller) {
        throw new Error('terminal_not_writable')
      }
      hooks?.beforeWrite?.(binding.ptyId)
      assertWritable()
      // A provider can throw after handoff, before returning its settlement promise.
      effectPossible = true
      const settlement = this.promptInputs.withChatWrite(binding.ptyId, binding.generation, () => {
        if (controller.writeWithSettlement) {
          return controller.writeWithSettlement(binding.ptyId, data, 'driving')
        }
        return { outcome: 'refused' as const, reason: 'provider_cannot_settle' as const }
      })
      // A provider call may already have handed bytes off even when its reply never arrives.
      let settled = await waitForAgentPromptPromise(Promise.resolve(settlement), entry.signal)
      if (settled.outcome === 'refused' && settled.reason === 'provider_cannot_settle') {
        assertWritable()
        const accepted = this.promptInputs.withChatWrite(binding.ptyId, binding.generation, () =>
          controller.write(binding.ptyId, data, 'driving')
        )
        settled = accepted
          ? { outcome: 'accepted' }
          : { outcome: 'refused', reason: 'provider_refused_write' }
        weak = true
      }
      if (settled.outcome === 'refused') {
        // Only a first proven refusal can undo the conservative handoff assumption.
        if (bytesWritten === 0) {
          effectPossible = false
        }
        throw settled
      }
      if (settled.outcome === 'unverifiable') {
        throw settled
      }
      bytesWritten += Buffer.byteLength(data)
      await hooks?.afterWrite?.()
    }
    const queued = this.serializeAgentPromptSubmission(
      binding.ptyId,
      binding.generation,
      async () => {
        try {
          if (hooks?.start) {
            chatPromptBinding = await hooks.start(assertWritable)
          } else {
            entry.start()
          }
          assertWritable()
          await perform(write, assertWritable)
          return weak
            ? result(false, writeUnverifiable('transport_settlement_lost', true))
            : result(true, { outcome: 'accepted' })
        } catch {
          return effectPossible
            ? result(false, writeUnverifiable('partial_write', true))
            : result(false)
        } finally {
          entry.finish()
        }
      }
    )
    try {
      return await waitForAgentPromptPromise(queued, entry.signal)
    } catch {
      return effectPossible
        ? result(false, writeUnverifiable('partial_write', true))
        : result(false)
    }
  }
}
