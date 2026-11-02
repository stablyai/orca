import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './terminal-input-dispatch'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
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
  protected readonly pluginHookOrder = new TerminalPluginHookOrder()

  sendTerminal(
    handle: string,
    action: TerminalSendAction,
    options: RuntimeTerminalWriteOptions
  ): Promise<RuntimeTerminalSend> {
    try {
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
    } catch (error) {
      return Promise.reject(error)
    }
  }

  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    try {
      const hooked = agentPromptHookApplies(options)
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
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** The checks callers ran on the original text, run again on what a plugin wrote. */
  protected async assertRewrittenTerminalTextAllowed(text: string): Promise<void> {
    await assertLegacyAiVaultResumeCommandAllowed(text, () =>
      this.ensureStructuredAgentSessionHost()
    )
  }
}
