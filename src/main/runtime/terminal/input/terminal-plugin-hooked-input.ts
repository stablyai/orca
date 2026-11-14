import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { createTerminalInputReservation } from './terminal-input-admission'
import { resolvePtyWriteHostPlatform } from './pty-write-host-platform'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-terminal-send-contract'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-sessions/structured-session-ownership'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './terminal-input-dispatch'
import type { RuntimeAgentPromptWriteOptions } from './agent-prompt-write-options'
import {
  agentPromptHookApplies,
  runAgentPromptPluginHook,
  runTerminalSendPluginHook,
  terminalHookOrderKind,
  TerminalPluginHookOrder,
  terminalSendHookApplies
} from './terminal-send-plugin-hook'

type TerminalSendAction = { text?: string; enter?: boolean; interrupt?: boolean }

/** Text and prompts Orca writes to terminals pass plugin hooks first (`terminal.send`,
 *  `agent.prompt.before`), in order per terminal; with no plugin listing one, a write adds no
 *  await. */
export abstract class OrcaRuntimeWithPluginHookedTerminalInput extends OrcaRuntimeWithControllerKnowsPtyIsLive {
  abstract assertTerminalAgentPromptInputSupported(handle: string): void

  protected readonly pluginHookOrder = new TerminalPluginHookOrder()

  protected getPtyAgent(ptyId: string): TerminalAgent | null {
    const pty = this.ptysById.get(ptyId)
    return pty?.launchAgent ?? pty?.foregroundAgent ?? null
  }

  protected writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    return this.terminalWriter.writeAction(ptyId, action, payload, {
      ...options,
      reserveWrite: createTerminalInputReservation(this, options.inputSource, options.reserveWrite)
    })
  }

  protected writeTerminalInputChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    return this.terminalWriter.writeChunks(ptyId, text, {
      ...options,
      reserveWrite: createTerminalInputReservation(this, options.inputSource, options.reserveWrite)
    })
  }

  protected getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    return resolvePtyWriteHostPlatform(this.ptysById.get(ptyId))
  }

  async sendTerminal(
    handle: string,
    action: TerminalSendAction,
    options: RuntimeTerminalWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const hooked = terminalSendHookApplies(action, options)
    return this.pluginHookOrder.run(
      handle,
      terminalHookOrderKind(hooked, action, options),
      action,
      // Why recheck inputKind: it narrows the type; terminalSendHookApplies already refused replies.
      (value) =>
        options.inputKind === 'query-reply'
          ? Promise.resolve(value)
          : runTerminalSendPluginHook(handle, value, options.inputKind, (text) =>
              this.assertRewrittenTerminalTextAllowed(text)
            ),
      (final) => this.sendTerminalAfterPluginHooks(handle, final, options)
    )
  }

  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const hooked = agentPromptHookApplies(options)
    this.assertTerminalAgentPromptInputSupported(handle)
    return this.pluginHookOrder.run(
      handle,
      terminalHookOrderKind(hooked, {}, options),
      prompt,
      (value) => {
        const pty = this.getLivePtyForHandle(handle)?.pty
        return runAgentPromptPluginHook(
          {
            handle,
            prompt: value,
            inputKind: options.inputKind,
            agent: pty?.foregroundAgent ?? pty?.launchAgent ?? null
          },
          (text) => this.assertRewrittenTerminalTextAllowed(text)
        )
      },
      // Why outside the order: a delivery may wait on a permission answer (`onPermission: 'wait'`).
      (final) => this.sendAgentPromptAfterPluginHooks(handle, final, options)
    )
  }

  /** The checks callers ran on the original text, run again on what a plugin wrote. */
  protected async assertRewrittenTerminalTextAllowed(text: string): Promise<void> {
    await assertLegacyAiVaultResumeCommandAllowed(text, () =>
      this.ensureStructuredAgentSessionHost()
    )
  }
}
