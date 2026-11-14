import { readRuntimeElapsedClock } from '../../hosts/runtime-elapsed-clock'
import {
  terminalChatPromptSchedule,
  type TerminalChatPromptSchedule
} from '../../../../shared/terminal/input/terminal-chat-prompt-budget'
import { OrcaRuntimeWithTerminalChatInputWriter } from './terminal-chat-input-writer'
import {
  assertLegacyAiVaultResumeCommandAllowed,
  hasLegacyAiVaultResumeCommand
} from '../../../ai-vault/structured-sessions/structured-session-ownership'
import type { TerminalChatInput } from './terminal-chat-input-ownership'
import type { AgentPromptExpectedBinding } from './agent-prompt-write-options'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { waitForAgentPromptDelay, waitForAgentPromptPromise } from './agent-prompt-signals'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-launch/startup/agent-tui-input-clear'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../shared/native-chat/input/native-chat-paste-bytes'
import { agentPromptSubmitJoinsPasteFrame } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../../shared/terminal/input/terminal-input'
import type {
  RuntimeTerminalSend,
  TerminalChatPrompt
} from '../../../../shared/runtime-terminal-send-contract'
import { writeRefused } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

export abstract class OrcaRuntimeWithTerminalChatPrompt extends OrcaRuntimeWithTerminalChatInputWriter {
  sendTerminalChatPrompt(
    handle: string,
    prompt: TerminalChatPrompt,
    expectedIncarnationId?: string,
    signal?: AbortSignal,
    preparedSchedule?: TerminalChatPromptSchedule
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
    const schedule = preparedSchedule ?? terminalChatPromptSchedule(prompt.text)
    const pty = this.ptysById.get(binding.ptyId)
    const agent = pty?.foregroundAgent ?? pty?.launchAgent ?? prompt.agent
    const gate = ['claude', 'codex'].includes(pty?.launchAgent ?? pty?.foregroundAgent ?? '')
    const requiredMs = schedule.scheduleMs(this.getPtyWriteHostPlatform(binding.ptyId), agent, gate)
    const clock = prompt.expiry ? readRuntimeElapsedClock() : null
    if (
      prompt.expiry &&
      (prompt.expiry.runtimeId !== this.getRuntimeId() ||
        !clock ||
        prompt.expiry.expiresAtMs <= clock.upper ||
        prompt.expiry.expiresAtMs - clock.lower > schedule.lifetimeMs)
    ) {
      return Promise.resolve(refused)
    }
    if (!prompt.expiry && requiredMs + 5000 > 30000) {
      return Promise.resolve(refused)
    }
    const body = buildNativeChatPasteBytes(prompt.text)
    const frames = [prompt.text, AGENT_TUI_CLEAR_INPUT_MAX, body]
    const byteLength =
      rawBytes + frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0) + 1
    const entry = this.promptInputs.admit(
      binding.ptyId,
      binding.generation,
      frames,
      byteLength,
      this.getPtyLifecycleSignal(binding.ptyId),
      prompt.expiry
        ? {
            expiresAtMs: prompt.expiry.expiresAtMs,
            executionMs: schedule.executionMs(requiredMs)
          }
        : undefined,
      signal
    )
    if (!entry) {
      return Promise.resolve(refused)
    }
    // Only the bounded entry retains frames while a preceding generated prompt owns the serializer.
    return this.runChatPrompt(
      handle,
      binding,
      entry,
      prompt.agent,
      schedule,
      prompt.expiry?.expiresAtMs
    ).catch(() => refused)
  }

  private async runChatPrompt(
    handle: string,
    binding: AgentPromptExpectedBinding & { generation: number },
    entry: TerminalChatInput,
    agentHint: TerminalAgent,
    schedule: TerminalChatPromptSchedule,
    expiresAtMs?: number
  ): Promise<RuntimeTerminalSend> {
    let agent = agentHint
    let platform: ReturnType<typeof this.getPtyWriteHostPlatform>
    return this.runTerminalChatInput(
      handle,
      binding,
      entry,
      async (write, assertWritable) => {
        const frames = entry.frames!
        const scheduleText = frames[0]
        await write(frames[1])
        const joined = agentPromptSubmitJoinsPasteFrame(agent)
        const gate = joined
          ? null
          : this.createAgentPromptRenderGate(
              binding.ptyId,
              schedule.ingestMs(platform),
              scheduleText,
              () => performance.now()
            )
        try {
          gate?.arm()
          await write(frames[2] + (joined ? NATIVE_CHAT_SUBMIT : ''))
          if (gate) {
            await waitForAgentPromptPromise(gate.wait(), entry.signal)
            assertWritable()
          }
        } finally {
          gate?.dispose()
        }
        if (!joined) {
          await waitForAgentPromptDelay(schedule.submitDelayMs(platform, agent), entry.signal)
          await write(NATIVE_CHAT_SUBMIT)
        }
      },
      'desktop',
      {
        start: async (assertWritable) => {
          assertWritable()
          const frames = entry.frames!
          const scheduleText = frames[0]
          const pty = this.ptysById.get(binding.ptyId)
          agent = pty?.foregroundAgent ?? pty?.launchAgent ?? agentHint
          const requiredMs = schedule.scheduleMs(
            this.getPtyWriteHostPlatform(binding.ptyId),
            agent,
            ['claude', 'codex'].includes(pty?.launchAgent ?? pty?.foregroundAgent ?? '')
          )
          const clock = expiresAtMs === undefined ? null : readRuntimeElapsedClock()
          if (
            expiresAtMs === undefined
              ? requiredMs + 5000 > 30000
              : !clock || expiresAtMs - clock.upper < requiredMs + 5000
          ) {
            throw new Error('Chat input request expired')
          }
          entry.start(schedule.executionMs(requiredMs))
          assertWritable()
          platform = this.getPtyWriteHostPlatform(binding.ptyId)
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
          assertWritable()
          return this.captureChatPromptBinding(handle, binding)
        }
      }
    )
  }
}
