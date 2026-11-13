import { OrcaRuntimeWithWriteTerminalAgentPrompt } from './terminal-agent-prompt'
import {
  assertLegacyAiVaultResumeCommandAllowed,
  hasLegacyAiVaultResumeCommand
} from '../../../ai-vault/structured-sessions/structured-session-ownership'
import { isTerminalForegroundObservation } from '../../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import type { TerminalChatInput } from './terminal-chat-input-ownership'
import type { AgentPromptExpectedBinding } from './agent-prompt-write-options'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { assertTerminalInputAdmitted } from './terminal-input-admission'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './agent-prompt-signals'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-launch/startup/agent-tui-input-clear'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../shared/native-chat/input/native-chat-paste-bytes'
import {
  agentPromptSubmitJoinsPasteFrame,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../../shared/terminal/input/terminal-input'
import type {
  RuntimeTerminalSend,
  TerminalChatPrompt
} from '../../../../shared/runtime-terminal-send-contract'
import {
  writeUnverifiable,
  writeRefused,
  type WriteSettlement
} from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

export abstract class OrcaRuntimeWithTerminalChatPrompt extends OrcaRuntimeWithWriteTerminalAgentPrompt {
  private async chatReceiverIsShell(binding: AgentPromptExpectedBinding): Promise<boolean> {
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

  sendTerminalChatPrompt(
    handle: string,
    prompt: TerminalChatPrompt,
    expectedIncarnationId?: string
  ): Promise<RuntimeTerminalSend> {
    const refused: RuntimeTerminalSend = {
      handle,
      accepted: false,
      bytesWritten: 0,
      writeSettlement: writeRefused('provider_refused_write')
    }
    let binding: ReturnType<typeof this.getTerminalPromptRequestBinding>
    try {
      binding = this.getTerminalPromptRequestBinding(handle)
    } catch {
      return Promise.resolve(refused)
    }
    if (
      expectedIncarnationId !== undefined &&
      expectedIncarnationId !== binding.processIncarnation
    ) {
      return Promise.resolve(refused)
    }
    const rawBytes = Buffer.byteLength(prompt.text)
    if (rawBytes > TERMINAL_INPUT_MAX_BYTES || !prompt.text) {
      return Promise.resolve(refused)
    }
    const pty = this.ptysById.get(binding.ptyId)
    const agent = pty?.foregroundAgent ?? pty?.launchAgent ?? prompt.agent
    const body = buildNativeChatPasteBytes(prompt.text)
    const frames = [prompt.text, AGENT_TUI_CLEAR_INPUT_MAX, body]
    const byteLength =
      rawBytes + frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0) + 1
    const entry = this.promptInputs.admit(
      binding.ptyId,
      binding.generation,
      frames,
      byteLength,
      this.getPtyLifecycleSignal(binding.ptyId)
    )
    if (!entry) {
      return Promise.resolve(refused)
    }
    // Only the bounded entry retains frames while a preceding generated prompt owns the serializer.
    return this.runChatPrompt(handle, binding, entry, agent).catch(() => refused)
  }

  private async runChatPrompt(
    handle: string,
    binding: AgentPromptExpectedBinding & { generation: number },
    entry: TerminalChatInput,
    agent: TerminalAgent
  ): Promise<RuntimeTerminalSend> {
    let bytesWritten = 0
    let effectPossible = false
    let weak = false
    const result = (accepted: boolean, writeSettlement?: WriteSettlement): RuntimeTerminalSend => ({
      handle,
      accepted,
      bytesWritten,
      writeSettlement: writeSettlement ?? writeRefused('provider_refused_write')
    })
    const assertWritable = (): void => {
      assertAgentPromptRequestActive(entry.signal)
      this.assertAgentPromptGeneration(binding.ptyId, binding.generation)
      this.assertAgentPromptExpectedBinding(handle, binding)
      this.assertLiveTerminalHandleTargetsPty(handle, binding.ptyId)
      if (!this.ptysById.get(binding.ptyId)?.connected || this.isPtyStopRequested(binding.ptyId)) {
        throw new Error('terminal_not_writable')
      }
      assertTerminalInputAdmitted(this, binding.ptyId, 'desktop')
    }
    const write = async (data: string): Promise<void> => {
      assertWritable()
      const controller = this.ptyController
      if (!controller) {
        throw new Error('terminal_not_writable')
      }
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
    }
    const queued = this.serializeAgentPromptSubmission(
      binding.ptyId,
      binding.generation,
      async () => {
        entry.start()
        try {
          assertWritable()
          const frames = entry.frames!
          const scheduleText = frames[0]
          const platform = this.getPtyWriteHostPlatform(binding.ptyId)
          if (
            hasLegacyAiVaultResumeCommand(scheduleText) &&
            (await waitForAgentPromptPromise(this.chatReceiverIsShell(binding), entry.signal))
          ) {
            let refusal: unknown
            try {
              await waitForAgentPromptPromise(
                assertLegacyAiVaultResumeCommandAllowed(scheduleText, () =>
                  this.ensureStructuredAgentSessionHost()
                ),
                entry.signal
              )
            } catch (error) {
              refusal = error
            }
            const stillShell = await waitForAgentPromptPromise(
              this.chatReceiverIsShell(binding),
              entry.signal
            )
            assertWritable()
            if (stillShell && refusal) {
              throw refusal
            }
          }
          await write(frames[1])
          const joined = agentPromptSubmitJoinsPasteFrame(agent)
          const gate = joined
            ? null
            : this.createAgentPromptRenderGate(
                binding.ptyId,
                getTerminalPasteIngestMs(platform, Buffer.byteLength(frames[2])),
                scheduleText
              )
          try {
            gate?.arm()
            await write(frames[2] + (joined ? NATIVE_CHAT_SUBMIT : ''))
            if (gate) {
              await waitForAgentPromptPromise(gate.wait(), entry.signal)
            }
          } finally {
            gate?.dispose()
          }
          if (!joined) {
            await waitForAgentPromptDelay(
              resolveAgentPromptSubmitDelayForAgent(platform, scheduleText, agent),
              entry.signal
            )
            await write(NATIVE_CHAT_SUBMIT)
          }
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
