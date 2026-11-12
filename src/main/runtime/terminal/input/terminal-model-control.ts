import { OrcaRuntimeWithTerminalChatPrompt } from './terminal-agent-prompt-chat'
import {
  buildTerminalModelControl,
  type TerminalModelControl,
  type TerminalModelControlResult
} from '../../../../shared/native-chat/input/native-chat-terminal-model-control'
import { createClaudeModelSwitchConfirmationObserver } from '../../../../shared/native-chat/input/native-chat-claude-model-switch-confirmation'
import { typeAgentTuiCommand } from '../../../../shared/agent-launch/startup/agent-tui-command-typing'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../shared/native-chat/input/native-chat-paste-bytes'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat/input/native-chat-answer-stepping'
import { waitForAgentPromptDelay, waitForAgentPromptPromise } from './agent-prompt-signals'
import type { TerminalInputSource } from './terminal-input-admission'

export abstract class OrcaRuntimeWithTerminalModelControl extends OrcaRuntimeWithTerminalChatPrompt {
  async controlTerminalModel(
    handle: string,
    control: TerminalModelControl,
    options: {
      expectedIncarnationId?: string
      inputSource: TerminalInputSource
      beforeWrite?: (ptyId: string) => void
      afterWrite?: () => Promise<void>
    }
  ): Promise<TerminalModelControlResult> {
    const blocked = (
      reason: 'foreign-draft' | 'target-unavailable' | 'unsupported-control' | 'admission'
    ): TerminalModelControlResult => ({ outcome: 'blocked', reason, agent: control.agent })
    let binding: ReturnType<typeof this.getTerminalPromptRequestBinding>
    try {
      binding = this.getTerminalPromptRequestBinding(handle)
    } catch {
      return blocked('target-unavailable')
    }
    if (
      options.expectedIncarnationId &&
      options.expectedIncarnationId !== binding.processIncarnation
    ) {
      return blocked('target-unavailable')
    }
    const pty = this.ptysById.get(binding.ptyId)
    const agent = pty?.foregroundAgent ?? pty?.launchAgent
    if (agent !== control.agent) {
      return { outcome: 'legacy' }
    }
    if (agent !== 'claude' && agent !== 'codex') {
      return { outcome: 'legacy' }
    }
    const command = buildTerminalModelControl(control)
    if (!command) {
      return blocked('unsupported-control')
    }
    const observing =
      control.observation?.detectAgentInteraction === 'claude-model-switch-confirmation' &&
      agent === 'claude'
    const entry = this.promptInputs.admit(
      binding.ptyId,
      binding.generation,
      [command.command],
      Buffer.byteLength(command.command) * 2 + (observing ? 128 * 1024 : 0) + 64,
      this.getPtyLifecycleSignal(binding.ptyId)
    )
    if (!entry) {
      return blocked('admission')
    }
    let outcome: TerminalModelControlResult = { outcome: 'unknown' }
    const send = await this.runTerminalChatInput(
      handle,
      binding,
      entry,
      async (write) => {
        if (
          (this.ptysById.get(binding.ptyId)?.foregroundAgent ??
            this.ptysById.get(binding.ptyId)?.launchAgent) !== agent
        ) {
          throw new Error('terminal_agent_changed')
        }
        const screen = await waitForAgentPromptPromise(
          this.readCurrentTerminalWaitScreen(binding.ptyId).catch(() => null),
          entry.signal
        )
        const draft = screen ? this.readCaughtUpComposerTypedText(binding.ptyId) : null
        if (draft === null) {
          outcome = { outcome: 'legacy' }
          return
        }
        if (draft.length > 0) {
          outcome = blocked('foreign-draft')
          return
        }
        const submitted = Promise.withResolvers<boolean>()
        let warning: Promise<boolean> | null = null
        const observer = observing
          ? createClaudeModelSwitchConfirmationObserver({
              expectedModelLabel: control.observation?.expectedChoiceLabel ?? null,
              subscribeToData: (watcher) => this.subscribeToTerminalData(binding.ptyId, watcher),
              submitConfirmation: () => {
                warning ??= submitted.promise
                  .then(async (accepted) => {
                    if (!accepted) {
                      return false
                    }
                    await write(NATIVE_CHAT_SUBMIT)
                    return true
                  })
                  .catch(() => false)
                return warning
              }
            })
          : null
        try {
          if (observer) {
            await waitForAgentPromptPromise(observer.ready, entry.signal)
          }
          observer?.arm()
          if (agent === 'codex') {
            const typed = await typeAgentTuiCommand({
              command: entry.frames![0],
              signal: entry.signal,
              write: async (key) => {
                await write(key)
                return 'accepted'
              }
            })
            if (typed !== 'accepted') {
              throw new Error('command_not_accepted')
            }
          } else {
            await write(buildNativeChatPasteBytes(entry.frames![0]))
            await waitForAgentPromptDelay(NATIVE_CHAT_SUBMIT_DELAY_MS, entry.signal)
            await write(NATIVE_CHAT_SUBMIT)
          }
          submitted.resolve(true)
          observer?.startDetection()
          outcome = observer
            ? { outcome: await waitForAgentPromptPromise(observer.result, entry.signal) }
            : { outcome: command.picker ? 'picker-opened' : 'dispatched' }
        } finally {
          submitted.resolve(false)
          observer?.dispose()
          if (warning) {
            await waitForAgentPromptPromise(warning, entry.signal).catch(() => false)
          }
        }
      },
      options.inputSource,
      {
        ...options,
        beforeWrite: (ptyId) => {
          const current = this.ptysById.get(ptyId)
          if ((current?.foregroundAgent ?? current?.launchAgent) !== agent) {
            throw new Error('terminal_agent_changed')
          }
          options.beforeWrite?.(ptyId)
        }
      }
    )
    return send.writeSettlement?.outcome === 'accepted'
      ? outcome
      : send.writeSettlement?.outcome === 'refused'
        ? blocked('target-unavailable')
        : { outcome: 'unknown' }
  }
}
